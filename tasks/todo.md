# Implementation

- [x] 1. Verify local UDS deployment, federation, SSO, and UI sources.
- [x] 2. Implement the TypeScript portal, deployment scripts, README, and AGENTS.md.
- [x] 3. Run checks, deploy UDS Core and the portal, and verify authentication and users.

## Verification

- `setup.sh`: initial deployment and repeat execution passed.
- `deploy.sh`: builds and deploys successfully; Deployment and Package are Ready.
- TypeScript check, production build, 3 backend tests, Helm lint, and shell syntax passed.
- Browser smoke test passed: admin SSO/MFA and users table/API; anonymous and non-admin denied.
- Live backend assertion exchange lists `uds-admin`; no synthetic test users remain.
- Teardown reviewed and syntax checked; not run, so the requested deployment remains available.
- Runtime corrections: assertion audience matches the admin hostname's discovery issuer;
  public gateway certificate uses Node's built-in CA trust without an absent extra CA ConfigMap.
- No blockers. No commits made.

## Demo password-only login

- [x] 1. Verify the UDS OTP override and existing-realm behavior.
- [x] 2. Update setup and browser checks for password-only login; document the setting.
- [x] 3. Apply to the running demo and verify admin access and non-admin denial.

- Verified `realmAuthFlows.OTP_ENABLED: false` is an initial-import setting, not
  a variable exposed by the prebuilt bundle. Setup applies equivalent realm API settings.
- `setup.sh`, shell syntax checks, and the password-only browser smoke test passed.
- Admin user listing, anonymous rejection, and non-admin rejection remain verified.

## Tenant gateway

- [x] 1. Inspect portal exposure, SSO redirect, and hostname references.
- [x] 2. Switch portal exposure and references to users.uds.dev.
- [x] 3. Redeploy and verify password-only admin access and non-admin denial.

- Deployment passed; Package reports tenant gateway and users.uds.dev.
- Browser test passed: password-only admin login, users table/API, and non-admin denial.
- Previous users.admin.uds.dev route returns 404.
