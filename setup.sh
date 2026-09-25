#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p .local
export KUBECONFIG="$PWD/.local/kubeconfig"
for tool in uds k3d kubectl docker curl jq openssl; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
docker info >/dev/null

# 1. Deploy pinned UDS Core base + identity services on this project's k3d cluster.
# Core's explicit development option creates the master-realm bootstrap admin.
if ! test -f .local/core-ready; then
  if k3d cluster list -o json | jq -e '.[] | select(.name == "uds-user-management")' >/dev/null && ! test -f .local/cluster-owner; then
    echo 'Cluster uds-user-management already exists and is not owned by this setup.' >&2
    exit 1
  fi
  touch .local/cluster-owner
  uds deploy oci://ghcr.io/defenseunicorns/packages/uds/bundles/k3d-core-slim-dev:1.11.0 \
    --set CLUSTER_NAME=uds-user-management \
    --set INSECURE_ADMIN_PASSWORD_GENERATION=true --confirm --resume --no-progress
  touch .local/core-ready
fi
test "$(kubectl config current-context)" = k3d-uds-user-management
kubectl -n keycloak rollout status statefulset/keycloak --timeout=300s

# Use a loopback-only tunnel for bootstrap. Credentials never enter the app image.
work_dir=$(mktemp -d)
tunnel_pid=''
cleanup() { test -z "$tunnel_pid" || kill "$tunnel_pid" 2>/dev/null || true; rm -rf "$work_dir"; }
trap cleanup EXIT
kubectl -n keycloak port-forward service/keycloak-http 18080:8080 >"$work_dir/tunnel.log" 2>&1 &
tunnel_pid=$!
for attempt in {1..60}; do
  kill -0 "$tunnel_pid" 2>/dev/null || { echo 'Keycloak tunnel failed; port 18080 must be free.' >&2; exit 1; }
  if curl -fsS http://127.0.0.1:18080/realms/master/.well-known/openid-configuration >/dev/null 2>&1; then break; fi
  sleep 1
done
bootstrap_user=$(kubectl -n keycloak get secret keycloak-admin-password -o jsonpath='{.data.username}' | base64 -d)
bootstrap_password=$(kubectl -n keycloak get secret keycloak-admin-password -o jsonpath='{.data.password}' | base64 -d)
bootstrap_token=$(curl -fsS http://127.0.0.1:18080/realms/master/protocol/openid-connect/token \
  --data-urlencode grant_type=password --data-urlencode client_id=admin-cli \
  --data-urlencode "username=$bootstrap_user" --data-urlencode "password=$bootstrap_password" | jq -er .access_token)
printf 'header = "Authorization: Bearer %s"\n' "$bootstrap_token" >"$work_dir/auth"
unset bootstrap_password bootstrap_token
kc() { curl --fail-with-body --silent --show-error --config "$work_dir/auth" \
  -H 'Content-Type: application/json' "http://127.0.0.1:18080/admin/realms/uds/$1" "${@:2}"; }

# Demo only: username/password login, without OTP.
# UDS's realmAuthFlows.OTP_ENABLED=false override only affects initial import.
# The prebuilt bundle does not expose it. Apply its equivalent to the existing
# realm so initial setup and reruns behave identically, without recreating users.
for flow in 'Conditional OTP' 'Conditional X509 2FA'; do
  flow_path=$(jq -rn --arg value "$flow" '$value | @uri')
  otp_execution=$(kc "authentication/flows/$flow_path/executions" | jq -ec '
    [.[] | select(.providerId == "auth-otp-form")] |
    if length == 1 then .[0] | .requirement = "DISABLED"
    else error("Expected exactly one UDS OTP execution") end')
  kc "authentication/flows/$flow_path/executions" -X PUT --data "$otp_execution"
done
password_flow='authentication/flows/Username%2FPassword%20Authentication/executions'
mfa_execution=$(kc "$password_flow" | jq -ec '
  [.[] | select(.displayName == "Conditional OTP" and .authenticationFlow == true)] |
  if length == 1 then .[0] | .requirement = "DISABLED"
  else error("Expected exactly one UDS password MFA subflow") end')
kc "$password_flow" -X PUT --data "$mfa_execution"
otp_action=$(kc authentication/required-actions/CONFIGURE_TOTP | jq '.enabled = false | .defaultAction = false')
kc authentication/required-actions/CONFIGURE_TOTP -X PUT --data "$otp_action"
echo 'Demo login configured: username and password; OTP disabled.'

# ============================================================================
# 2. KEYCLOAK CLIENT AND SERVICE ACCOUNT — Signed JWT - Federated
#    Trust UDS's Kubernetes identity provider and ONLY this Kubernetes SA subject.
#    Keycloak creates its own service-account user when serviceAccountsEnabled=true.
#    Assign user-management roles to that user. No shared client secret is used.
# ============================================================================
kc identity-provider/instances/uds-kubernetes | jq -e '.enabled == true' >/dev/null
client_id=$(kc 'clients?clientId=user-management-api' | jq -r '.[0].id // empty')
client_json='{
  "clientId": "user-management-api",
  "protocol": "openid-connect",
  "enabled": true,
  "publicClient": false,
  "clientAuthenticatorType": "federated-jwt",
  "standardFlowEnabled": false,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": true,
  "fullScopeAllowed": true,
  "attributes": {
    "jwt.credential.issuer": "uds-kubernetes",
    "jwt.credential.sub": "system:serviceaccount:user-management:user-management"
  }
}'
if test -z "$client_id"; then
  kc clients -X POST --data "$client_json"
  client_id=$(kc 'clients?clientId=user-management-api' | jq -er '.[0].id')
else
  kc "clients/$client_id" -X PUT --data "$client_json"
fi
service_account_id=$(kc "clients/$client_id/service-account-user" | jq -er .id)
realm_management_id=$(kc 'clients?clientId=realm-management' | jq -er '.[0].id')
roles=$(kc "clients/$realm_management_id/roles" | jq '[.[] | select(.name == "manage-users" or .name == "view-users" or .name == "query-users")]')
test "$(jq length <<<"$roles")" = 3
kc "users/$service_account_id/role-mappings/clients/$realm_management_id" -X POST --data "$roles"
echo 'Configured user-management-api: federated Kubernetes identity and user-management roles.'

# 3. Create a local human admin in the existing UDS Core/Admin group.
# Re-running setup preserves that user's password and other account settings.
portal_user=${PORTAL_ADMIN_USER:-uds-admin}
portal_user_query=$(jq -rn --arg value "$portal_user" '$value | @uri')
user_id=$(kc "users?username=$portal_user_query&exact=true" | jq -r '.[0].id // empty')
if test -z "$user_id"; then
  portal_password="Aa1!!$(openssl rand -hex 24)"
  user_json=$(jq -n --arg username "$portal_user" --arg password "$portal_password" \
    '{username:$username,enabled:true,credentials:[{type:"password",value:$password,temporary:false}]}')
  kc users -X POST --data "$user_json"
  user_id=$(kc "users?username=$portal_user_query&exact=true" | jq -er '.[0].id')
  printf 'Username: %s\nPassword: %s\n' "$portal_user" "$portal_password" >.local/admin-credentials
  unset portal_password user_json
fi
admin_group_id=$(kc 'group-by-path/UDS%20Core/Admin' | jq -er .id)
kc "users/$user_id/groups/$admin_group_id" -X PUT
echo 'Setup complete. Local login credentials: .local/admin-credentials (if newly created).'
