# UDS User Management

A TypeScript/React single-page application that lists users in Keycloak's `uds` realm.
An Express backend calls the Keycloak Admin REST API using Kubernetes service-account
JWT assertions. The browser never receives these credentials.

## Run locally on UDS Core

Prerequisites: Docker, k3d, UDS CLI, kubectl, Helm, Node.js 22.12+, npm, curl, jq,
and OpenSSL. Docker must be running. Ports 80, 443, 6550, and 18080 must be available.

```sh
./setup.sh
./deploy.sh
```

Open <https://users.uds.dev> on the tenant gateway. Setup creates the local `uds-admin` user and
writes its generated password to `.local/admin-credentials` (mode 600). Override
the username with `PORTAL_ADMIN_USER` on the first setup. Re-running setup preserves
existing account passwords. Login uses username and password, without OTP. Complete
any required profile fields at first login.

The required built-in group is `/UDS Core/Admin` (singular), not `/UDS Core/Admins`.
Setup adds the local user to this existing group. Master-realm administrators are
separate from users of the `uds` realm.

Setup pins the `k3d-core-slim-dev:1.11.0` bundle: Core base (mesh and policy) plus
identity/authorization (Keycloak and Authservice). It creates the dedicated
`uds-user-management` cluster and uses `.local/kubeconfig`, leaving your normal
kubeconfig separate. This is a development environment; it explicitly enables Core's
bootstrap admin password generation and uses the bundle's development data stores.
Do not use this setup as a production deployment.
The development bootstrap master-admin Secret is retained in `keycloak` for setup
reruns and browser tests. Treat it as a cluster-wide privileged credential.

UDS's OTP override is `realmAuthFlows.OTP_ENABLED: false` on the Keycloak chart.
It affects initial realm import only and is not exposed by the pinned prebuilt bundle.
`setup.sh` applies the equivalent Keycloak Admin API settings on every run: disable
OTP executions, the password MFA subflow, and OTP enrollment. This also updates an
existing demo without deleting users. It is deliberately a password-only demo;
SSO and the `/UDS Core/Admin` access restriction remain enforced.

The UDS development domains must resolve to this laptop. If your DNS does not resolve
them, add `127.0.0.1 users.uds.dev keycloak.admin.uds.dev sso.uds.dev` to your
hosts file. Use the development bundle's CA in your browser if it is not already trusted.

```sh
./teardown.sh
```

Teardown deletes only this project's k3d cluster and its data, including all Keycloak
users created there. It removes local login credentials and kubeconfig. This is irreversible.

## Authentication

1. `chart/templates/package.yaml` registers `user-management-sso` through the UDS
   Package CR. Authservice handles the browser login and requires `/UDS Core/Admin`.
2. Authservice forwards a signed ID token in `Authorization: Bearer ...`. The backend
   verifies signature, issuer, audience, expiry, and group before serving the SPA or API.
3. A projected Kubernetes token identifies
   `system:serviceaccount:user-management:user-management`, with audience
   `https://keycloak.admin.uds.dev/realms/uds`. Kubernetes rotates it automatically.
   This must match discovery's issuer on the **admin hostname**, where this backend
   exchanges assertions. Browser ID tokens use the separate `sso.uds.dev` issuer.
4. `setup.sh` creates `user-management-api` using `federated-jwt`, bound to that exact
   subject through the existing `uds-kubernetes` identity provider. Its Keycloak
   service-account user receives `manage-users`, `view-users`, and `query-users`.
   Management permission is provisioned as requested; this app exposes only listing.
5. The backend exchanges the assertion for an access token using `client_credentials`.
   It reads the current projected token at each exchange and caches the access token
   only until shortly before expiry. No shared client secret is configured.
6. Admin REST calls go through `https://keycloak.admin.uds.dev`, respecting Core's
   restrictions on direct access to `/admin`. TLS uses Node's trusted CA store;
   the pinned development bundle has a publicly trusted gateway certificate.

The Kubernetes service account has no API RBAC grants and no default token mount.
Only the audience-bound assertion is mounted. The two Keycloak clients have distinct
purposes: browser SSO and workload access.

## Development

```sh
npm ci
npm run build
npm test
helm lint chart
bash -n setup.sh deploy.sh teardown.sh
./deploy.sh
npm run test:browser
```

The browser check uses an installed Chrome (`BROWSER_EXECUTABLE` overrides
`/usr/bin/google-chrome`). It creates two synthetic users, tests real admin SSO,
password-only login (failing on any OTP prompt), user listing, and non-admin rejection,
then deletes those users. It saves an actual UI screenshot to `.local/portal.png`.
The test leaves realm security settings unchanged.

`deploy.sh` checks the app, builds its container, packages the image and Helm chart
with Zarf, and deploys them. No external image registry credentials are needed for
the application image. Dependency versions are locked in `package-lock.json`.

- `web/src/`: user table and presentation.
- `server/auth.ts`: verified browser identity and admin group enforcement.
- `server/keycloak.ts`: assertion exchange and typed Admin REST access.
- `server/index.ts`: HTTP routes and static SPA serving.
- `chart/`: workload, projected token, networking, and Package CR SSO.
- `setup.sh`: cluster bootstrap, explicit client/service-account block, local admin.
- `tests/`: security and API regression checks.

Add future operations in the backend API and Keycloak module, then expose them in
the UI. Keep service credentials server-side and validate each new input. There is
no database or separate browser authentication framework to maintain.

## Sources

- [UDS local deployment](https://docs.defenseunicorns.com/core/getting-started/local-demo/install-and-deploy-uds/)
- [Package CR SSO example](https://docs.defenseunicorns.com/core/getting-started/local-demo/integrate-your-package/)
- [UDS authentication flow overrides](https://docs.defenseunicorns.com/core/reference/configuration/identity-and-authorization/#authentication-flow-variables)
- [UDS realm and federated client configuration](https://github.com/defenseunicorns/uds-identity-config/blob/v0.30.0/src/realm.json5)
- [Keycloak federated client authentication](https://www.keycloak.org/2026/01/federated-client-authentication)
- [UDS Portal UI styling reference](https://github.com/defenseunicorns/uds-portal/tree/main/ui/src)
