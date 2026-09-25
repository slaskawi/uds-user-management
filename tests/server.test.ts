import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import type { Server } from "node:http";
import { createApp } from "../server/index.js";
import { KeycloakAdmin } from "../server/keycloak.js";

const issuer = "https://sso.uds.dev/realms/uds";
const audience = "user-management-sso";
const group = "/UDS Core/Admin";
const env = {
  KEYCLOAK_URL: "https://keycloak.admin.uds.dev",
  KEYCLOAK_REALM: "uds",
  OIDC_ISSUER: issuer,
  OIDC_CLIENT_ID: audience,
  REQUIRED_GROUP: group,
  SA_TOKEN_PATH: "/service-account/token",
};
const { privateKey, publicKey } = await generateKeyPair("RS256");
const otherKey = await generateKeyPair("RS256");

describe("portal server", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = createApp({
      env,
      jwksKey: async () => publicKey,
      keycloak: { users: async () => ({ users: [{ id: "u1" }], hasMore: false }) },
      staticDir: "/path/that/does/not/exist",
    });
    server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.close();
    await once(server, "close");
  });

  async function token(
    key = privateKey,
    claims: Record<string, unknown> = { groups: [group] },
    aud = audience,
    tokenIssuer = issuer,
    expiration: string | number | null = "5m",
  ) {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(tokenIssuer)
      .setAudience(aud)
      .setSubject("alice")
      .setIssuedAt();
    if (expiration) jwt = jwt.setExpirationTime(expiration);
    return jwt.sign(key);
  }

  it("leaves only healthz public and requires a valid admin ID token everywhere else", async () => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/healthz/`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/healthz`, { method: "HEAD" })).status, 401);
    for (const path of ["/", "/api/users", "/missing"]) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: "Bearer not.a.jwt" } })).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${await token(otherKey.privateKey)}` } })).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${await token(privateKey, { groups: ["/UDS Core/Users"] })}` } })).status, 403);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${await token(privateKey, { groups: [group] }, "wrong-audience")}` } })).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${await token(privateKey, { groups: [group] }, audience, "https://wrong-issuer", "5m")}` } })).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${await token(privateKey, { groups: [group] }, audience, issuer, null)}` } })).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${await token(privateKey, { groups: [group] }, audience, issuer, 1)}` } })).status, 401);
    }
    const authorized = await fetch(`${baseUrl}/api/users`, { headers: { authorization: `Bearer ${await token()}` } });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { users: [{ id: "u1" }], hasMore: false });
  });

  it("validates pagination before calling Keycloak", async () => {
    const auth = { authorization: `Bearer ${await token()}` };
    assert.equal((await fetch(`${baseUrl}/api/users?max=101`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/users?first=-1`, { headers: auth })).status, 400);
  });
});

it("rereads rotated assertions, caches access tokens, retries one 401, and returns bounded pages", async () => {
  let assertionReads = 0;
  let rejectFirstToken = false;
  const exchanges: string[] = [];
  const pageRequests: string[] = [];
  const apiUsers = [
    { id: "1", username: "one", firstName: null, internal: "drop" },
    { id: "2", username: "two" },
    { id: "3", username: "three" },
  ];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/protocol/openid-connect/token")) {
      const form = new URLSearchParams(String(init?.body));
      exchanges.push(form.get("client_assertion")!);
      assert.equal(form.get("client_id"), null);
      return Response.json({ access_token: `access-${exchanges.length}`, expires_in: 3600 });
    }
    pageRequests.push(url);
    const bearer = new Headers(init?.headers).get("authorization");
    if (rejectFirstToken && bearer === "Bearer access-1") return new Response(null, { status: 401 });
    return Response.json(apiUsers);
  };
  const admin = new KeycloakAdmin(
    { baseUrl: "https://keycloak.admin.uds.dev", realm: "uds", serviceAccountTokenPath: "/sa/token" },
    fetcher,
    async () => `assertion-${++assertionReads}`,
  );

  assert.deepEqual(await admin.users(0, 2), {
    users: [{ id: "1", username: "one" }, { id: "2", username: "two" }],
    hasMore: true,
  });
  assert.deepEqual(await admin.users(2, 2), {
    users: [{ id: "1", username: "one" }, { id: "2", username: "two" }],
    hasMore: true,
  });
  assert.equal(assertionReads, 1);
  assert.deepEqual(new URL(pageRequests[0]).searchParams.toString(), "first=0&max=3");

  rejectFirstToken = true;
  await admin.users(0, 2);
  assert.equal(assertionReads, 2);
  assert.deepEqual(exchanges, ["assertion-1", "assertion-2"]);
});
