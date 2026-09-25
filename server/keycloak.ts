import { readFile } from "node:fs/promises";

export type KeycloakUser = {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
  emailVerified?: boolean;
};

type Config = {
  baseUrl: string;
  realm: string;
  serviceAccountTokenPath: string;
};

export class KeycloakAdmin {
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private tokenRequest?: Promise<string>;

  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
    private readonly readAssertion: (path: string) => Promise<string> = async (path) =>
      (await readFile(path, "utf8")).trim(),
    private readonly now: () => number = Date.now,
  ) {}

  async users(first: number, max: number): Promise<{ users: KeycloakUser[]; hasMore: boolean }> {
    const query = new URLSearchParams({ first: String(first), max: String(max + 1) });
    const url = `${this.config.baseUrl}/admin/realms/${encodeURIComponent(this.config.realm)}/users?${query}`;
    const response = await this.request(url);
    if (!response.ok) throw new Error(`Keycloak Admin API returned ${response.status}`);
    const users: unknown = await response.json();
    if (!Array.isArray(users) || !users.every(isUser)) throw new Error("Keycloak returned an invalid users response");
    return { users: users.slice(0, max).map(minimalUser), hasMore: users.length > max };
  }

  private async request(url: string): Promise<Response> {
    let token = await this.getToken();
    let response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) {
      if (this.accessToken === token) {
        this.accessToken = undefined;
        this.tokenExpiresAt = 0;
      }
      token = await this.getToken();
      response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    }
    return response;
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && this.now() < this.tokenExpiresAt - 5_000) return this.accessToken;
    if (!this.tokenRequest) {
      this.tokenRequest = this.exchangeToken().finally(() => { this.tokenRequest = undefined; });
    }
    return this.tokenRequest;
  }

  private async exchangeToken(): Promise<string> {
    const assertion = await this.readAssertion(this.config.serviceAccountTokenPath);
    if (!assertion) throw new Error("Kubernetes service-account token is empty");

    const response = await this.fetcher(
      `${this.config.baseUrl}/realms/${encodeURIComponent(this.config.realm)}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`Keycloak token endpoint returned ${response.status}`);
    const result = await response.json() as { access_token?: string; expires_in?: number };
    if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in! <= 0) {
      throw new Error("Keycloak returned an invalid access token response");
    }
    this.accessToken = result.access_token;
    this.tokenExpiresAt = this.now() + result.expires_in! * 1_000;
    return this.accessToken;
  }
}

function minimalUser(user: KeycloakUser): KeycloakUser {
  return Object.fromEntries(Object.entries({
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    enabled: user.enabled,
    emailVerified: user.emailVerified,
  }).filter(([, value]) => value != null)) as KeycloakUser;
}

function isUser(user: unknown): user is KeycloakUser {
  if (!user || typeof user !== "object" || typeof (user as KeycloakUser).id !== "string") return false;
  const candidate = user as KeycloakUser;
  return [candidate.username, candidate.firstName, candidate.lastName, candidate.email]
    .every((value) => value == null || typeof value === "string")
    && [candidate.enabled, candidate.emailVerified]
      .every((value) => value == null || typeof value === "boolean");
}
