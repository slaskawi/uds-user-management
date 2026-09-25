# Development

- Scope: list Keycloak users only. Keep extensions small and feature-driven.
- Read README.md before changing authentication or deployment.
- Check git status and git diff before editing. Preserve unrelated work.
- Track multi-step work in tasks/todo.md; follow its order.
- Use TypeScript with strict checks. React renders the SPA; Express owns the API.
- Keep Keycloak Admin REST calls in server/keycloak.ts and browser API calls in the frontend.
- Never send Kubernetes assertions, service-account access tokens, or client secrets to browsers.
- Keep Package CR Authservice SSO and backend token verification. Require /UDS Core/Admin.
- Do not disable TLS verification or add authentication bypasses for development.
- Use projected Kubernetes tokens with the issuer advertised on the admin hostname
  as audience. Browser tokens use the SSO hostname's issuer. Reread rotated tokens.
- Keycloak Admin APIs must use the admin gateway; direct service access is restricted by Core.
- No new user-management actions without corresponding authorization checks and tests.
- Verify changes with npm run build, npm test, helm lint chart, and bash -n setup.sh deploy.sh teardown.sh.
- For deployment changes, run ./deploy.sh and check Package readiness and SSO access.
- Keep setup.sh's client/service-account block explicit and readable.
- This local demo deliberately disables OTP in setup.sh. Browser tests must verify
  password-only login while continuing to reject users outside /UDS Core/Admin.
- Never commit .local, credentials, generated packages, or node_modules.
- Commit only when requested, with git commit -s. Do not add agent co-authors.
