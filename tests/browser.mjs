import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kubeconfig = path.join(root, '.local/kubeconfig');
const portalUrl = process.env.PORTAL_URL ?? 'https://users.uds.dev';
const executablePath = process.env.BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome';
const realm = 'uds';

test('UDS Admins can list Keycloak users and other users are denied', { timeout: 180_000 }, async () => {
  assert.ok(existsSync(kubeconfig), 'Run setup.sh before the browser test.');
  assert.ok(existsSync(executablePath), 'Set BROWSER_EXECUTABLE to an installed Chrome binary.');

  let tunnel;
  let browser;
  let adminToken;
  const fixtures = [];
  let failure;

  try {
    tunnel = await startKeycloakTunnel();
    const admin = await getBootstrapToken(tunnel.url);
    adminToken = admin.token;

    const group = await keycloakJson(tunnel.url, adminToken, 'group-by-path/UDS%20Core/Admin');
    assert.equal(group.path, '/UDS Core/Admin', 'Expected existing UDS Core Admin group.');
    assert.ok(group.id, 'UDS Core Admin group has no Keycloak id.');

    const suffix = randomUUID().slice(0, 10);
    fixtures.push(
      makeFixture(`portal-e2e-admin-${suffix}`, 'Admin'),
      makeFixture(`portal-e2e-user-${suffix}`, 'User'),
    );

    for (const fixture of fixtures) {
      const existing = await keycloakJson(
        tunnel.url,
        adminToken,
        `users?${new URLSearchParams({ username: fixture.username, exact: 'true' })}`,
      );
      assert.equal(existing.length, 0, 'A synthetic username already exists; refusing to modify it.');
      await keycloakJson(tunnel.url, adminToken, 'users', {
        method: 'POST',
        body: JSON.stringify({
          username: fixture.username,
          firstName: 'Portal E2E',
          lastName: fixture.lastName,
          email: `${fixture.username}@example.invalid`,
          enabled: true,
          emailVerified: false,
          attributes: { portalE2EFixture: ['true'] },
          credentials: [{ type: 'password', value: fixture.password, temporary: false }],
        }),
      }, true);
      fixture.created = true;
      const found = await keycloakJson(
        tunnel.url,
        adminToken,
        `users?${new URLSearchParams({ username: fixture.username, exact: 'true' })}`,
      );
      const user = found.find((item) => item.username === fixture.username);
      assert.ok(user?.id, 'Keycloak did not return the created fixture user.');
      fixture.id = user.id;
    }

    await keycloakJson(
      tunnel.url,
      adminToken,
      `users/${fixtures[0].id}/groups/${group.id}`,
      { method: 'PUT' },
      true,
    );

    browser = await chromium.launch({ headless: true, executablePath });
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const adminPage = await adminContext.newPage();

    assert.equal(await logIntoPortal(adminPage, fixtures[0], true), true);
    await adminPage.getByRole('heading', { level: 1, name: 'Users' }).waitFor();
    await adminPage.getByRole('columnheader', { name: 'Username' }).waitFor();

    const apiUsers = await findPortalUser(adminContext, fixtures[0].username);
    assert.ok(apiUsers, 'Authenticated portal API did not return the admin fixture.');

    const adminRow = await findTableRow(adminPage, fixtures[0].username);
    const rowText = await adminRow.innerText();
    assert.ok(rowText.includes(fixtures[0].username));
    assert.ok(rowText.includes(`${fixtures[0].username}@example.invalid`));
    assert.match(rowText, /Enabled/);
    mkdirSync(path.join(root, '.local'), { recursive: true });
    await adminPage.screenshot({ path: path.join(root, '.local/portal.png'), fullPage: true });

    const userContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const anonymousResponse = await userContext.request.get(new URL('/api/users', portalUrl).toString(), { maxRedirects: 0 });
    assert.notEqual(anonymousResponse.status(), 200, 'An unauthenticated request received the user API.');
    const userPage = await userContext.newPage();
    const denied = await logIntoPortal(userPage, fixtures[1], false);
    assert.equal(denied, false, 'A user outside UDS Core/Admin reached the portal.');
    assert.equal(await userPage.getByRole('columnheader', { name: 'Username' }).count(), 0);
    const deniedResponse = await userContext.request.get(new URL('/api/users', portalUrl).toString(), { maxRedirects: 0 });
    assert.notEqual(deniedResponse.status(), 200, 'Non-admin browser session received the user API.');

    await userContext.close();
    await adminContext.close();
  } catch (error) {
    failure = error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (tunnel && adminToken) {
      try {
        adminToken = (await getBootstrapToken(tunnel.url)).token;
      } catch {
        failure ??= new Error('Could not refresh the Keycloak bootstrap token for fixture cleanup.');
      }
      for (const fixture of fixtures) {
        if (!fixture.created) continue;
        try {
          const users = fixture.id
            ? [{ id: fixture.id }]
            : await keycloakJson(
                tunnel.url,
                adminToken,
                `users?${new URLSearchParams({ username: fixture.username, exact: 'true' })}`,
              );
          for (const user of users) {
            await keycloakJson(tunnel.url, adminToken, `users/${user.id}`, { method: 'DELETE' }, true);
          }
        } catch {
          failure ??= new Error('Could not remove a synthetic browser-test user.');
        }
      }
    }
    if (tunnel) await stopProcess(tunnel.process);
  }

  if (failure) throw failure;
});

function makeFixture(username, kind) {
  return {
    username,
    lastName: `${kind} fixture ${username.slice(-10)}`,
    password: `Aa1!!${randomBytes(24).toString('base64url')}`,
  };
}

function kubectl(args) {
  try {
    return execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`kubectl ${args[0]} failed; confirm Core is deployed and .local/kubeconfig is current.`);
  }
}

async function startKeycloakTunnel() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

  const child = spawn('kubectl', [
    '--kubeconfig', kubeconfig,
    '-n', 'keycloak',
    'port-forward',
    '--address=127.0.0.1',
    'service/keycloak-http',
    `${port}:8080`,
  ], { stdio: 'ignore' });
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (spawnFailed || child.exitCode !== null) throw new Error('Could not open a loopback Keycloak port-forward.');
    try {
      const response = await fetch(`${url}/realms/master/.well-known/openid-configuration`);
      if (response.ok) return { process: child, url };
    } catch {
      // The tunnel can take a moment to start accepting connections.
    }
    await delay(250);
  }
  await stopProcess(child);
  throw new Error('Timed out opening a loopback Keycloak port-forward.');
}

async function getBootstrapToken(baseUrl) {
  let username;
  let password;
  try {
    username = Buffer.from(kubectl(['-n', 'keycloak', 'get', 'secret', 'keycloak-admin-password', '-o', 'jsonpath={.data.username}']), 'base64').toString();
    password = Buffer.from(kubectl(['-n', 'keycloak', 'get', 'secret', 'keycloak-admin-password', '-o', 'jsonpath={.data.password}']), 'base64').toString();
  } catch {
    throw new Error('Could not read the Core bootstrap admin secret.');
  }

  try {
    const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }),
    });
    if (!response.ok) throw new Error();
    const token = (await response.json()).access_token;
    if (typeof token !== 'string' || !token) throw new Error();
    return { token };
  } catch {
    throw new Error('Could not obtain the temporary Keycloak bootstrap token.');
  } finally {
    username = undefined;
    password = undefined;
  }
}

async function keycloakJson(baseUrl, token, resource, init = {}, allowEmpty = false) {
  const response = await fetch(`${baseUrl}/admin/realms/${realm}/${resource}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Keycloak Admin API returned ${response.status}.`);
  if (allowEmpty || response.status === 204) return undefined;
  return response.json();
}

async function logIntoPortal(page, fixture, expectPortal) {
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
  let submittedPassword = false;

  for (let step = 0; step < 8; step++) {
    assert.equal(
      await page.locator('#totpSecret, #totp, input[name="otp"], input[name="totp"]').count(),
      0,
      'The password-only login flow displayed an MFA challenge.',
    );
    if (await page.getByRole('columnheader', { name: 'Username' }).count()) return true;

    const username = page.locator('#username');
    if (await username.isVisible().catch(() => false)) {
      if (submittedPassword) return false;
      await username.fill(fixture.username);
      await page.locator('#password').fill(fixture.password);
      await page.locator('#kc-login').click();
      submittedPassword = true;
      continue;
    }

    const acceptTerms = page.locator('#kc-accept');
    if (await acceptTerms.isVisible().catch(() => false)) {
      await acceptTerms.click();
      continue;
    }

    if (!expectPortal && submittedPassword) return false;
    await page.waitForTimeout(250);
  }

  if (!expectPortal && submittedPassword) return false;
  throw new Error('The SSO flow did not reach the portal.');
}

async function findPortalUser(context, username) {
  for (let first = 0; first <= 10_000; first += 100) {
    const url = new URL('/api/users', portalUrl);
    url.search = new URLSearchParams({ first: String(first), max: '100' }).toString();
    const response = await context.request.get(url.toString());
    assert.equal(response.status(), 200, 'Admin session could not call the protected users API.');
    const page = await response.json();
    if (page.users.some((user) => user.username === username)) return true;
    if (!page.hasMore) return false;
  }
  throw new Error('Stopped searching after 10,000 Keycloak users.');
}

async function findTableRow(page, username) {
  for (let index = 0; index < 40; index++) {
    const row = page.locator('tbody tr').filter({ hasText: username }).first();
    if (await row.count()) return row;
    const next = page.getByRole('button', { name: 'Next' });
    if (!(await next.isEnabled().catch(() => false))) break;
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/users');
    await next.click();
    await responsePromise;
  }
  throw new Error('Admin table did not show the synthetic Keycloak user.');
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit').catch(() => {}), delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
