import express, { type Express } from "express";
import { resolve } from "node:path";
import { requireAdmin } from "./auth.js";
import { KeycloakAdmin } from "./keycloak.js";

type AppOptions = {
  env?: NodeJS.ProcessEnv;
  keycloak?: Pick<KeycloakAdmin, "users">;
  jwksKey?: Parameters<typeof requireAdmin>[0]["getKey"];
  staticDir?: string;
};

export function createApp(options: AppOptions = {}): Express {
  const env = options.env ?? process.env;
  const keycloakUrl = required(env, "KEYCLOAK_URL").replace(/\/$/, "");
  const realm = required(env, "KEYCLOAK_REALM");
  const issuer = required(env, "OIDC_ISSUER");
  const audience = required(env, "OIDC_CLIENT_ID");
  const tokenPath = required(env, "SA_TOKEN_PATH");
  const keycloak = options.keycloak ?? new KeycloakAdmin({
    baseUrl: keycloakUrl,
    realm,
    serviceAccountTokenPath: tokenPath,
  });
  const jwksUri = `${keycloakUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`;

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });
  const authenticate = requireAdmin({ issuer, audience, jwksUri, getKey: options.jwksKey, requiredGroup: required(env, "REQUIRED_GROUP") });
  app.use((req, res, next) => {
    if (req.method === "GET" && req.path === "/healthz") return next();
    res.set("Cache-Control", "no-store");
    return authenticate(req, res, next);
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/users", async (req, res) => {
    const first = parseInteger(req.query.first, 0, 0, 1_000_000);
    const max = parseInteger(req.query.max, 50, 1, 100);
    if (first === null || max === null) return res.status(400).json({ error: "invalid pagination" });
    try {
      res.json(await keycloak.users(first, max));
    } catch (error) {
      console.error("Failed to list Keycloak users", error);
      res.status(502).json({ error: "Keycloak request failed" });
    }
  });

  const staticDir = options.staticDir ?? resolve("dist/client");
  app.use(express.static(staticDir, { cacheControl: false }));
  app.get(["/", "/login"], (_req, res) => res.sendFile(resolve(staticDir, "index.html"), { cacheControl: false }));
  return app;
}

export function startServer(): void {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1-65535");
  createApp().listen(port, () => console.log(`User management portal listening on ${port}`));
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
