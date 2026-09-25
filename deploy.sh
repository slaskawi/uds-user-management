#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export KUBECONFIG="$PWD/.local/kubeconfig"
test -f .local/core-ready || { echo 'Run ./setup.sh first.' >&2; exit 1; }
test "$(kubectl config current-context)" = k3d-uds-user-management
npm ci
npm run check
npm test
helm lint chart
image="user-management:$(date +%s)"
docker build --tag "$image" .
uds zarf package create . --set "IMAGE=$image" --confirm --output .local
architecture=$(docker info --format '{{.Architecture}}')
case "$architecture" in x86_64) architecture=amd64 ;; aarch64) architecture=arm64 ;; esac
uds zarf package deploy ".local/zarf-package-user-management-$architecture-0.1.0.tar.zst" --confirm
kubectl -n user-management rollout status deployment/user-management --timeout=300s
kubectl -n user-management wait package/user-management --for=jsonpath='{.status.phase}'=Ready --timeout=300s
printf '%s\n' '' \
  'Deployment complete. Next steps:' \
  '1. Open https://users.uds.dev.' \
  '2. Choose Google SSO and sign in with your Defense Unicorns account.' \
  '3. Your account must belong to /UDS Core/Admin to view users.'
