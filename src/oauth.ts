import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";

// Google sign-in for mail, for accounts that can't make app passwords. The user creates a
// "Desktop app" OAuth client in their own Google Cloud project and saves its JSON in the
// workspace; `resumetron email authorize` runs the one-time consent in a browser and stores the
// refresh token next to it. Neither file is ever written to the repo or printed.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_SCOPE = "https://mail.google.com/";

export interface OAuthPaths {
  clientFile: string;
  tokenFile: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export const resolveIn = (root: string, p: string) => (isAbsolute(p) ? p : join(root, p));

/** Reads a client JSON as Google downloads it ({"installed": {...}}), or a flat {client_id, client_secret}. */
export function readClient(file: string): OAuthClient {
  if (!existsSync(file)) throw new Error(`OAuth client file not found: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new Error(`${file} has no client_id and client_secret`);
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export function consentUrl(client: OAuthClient, redirectUri: string, challenge: string, state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token endpoint: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ""}`);
  return data;
}

/**
 * Runs the one-time consent: listens on a loopback port, hands the consent URL to `show`, and
 * stores the refresh token when Google redirects back. Resolves with the token file's path.
 */
export async function authorize(paths: OAuthPaths, opts: { loginHint?: string; show: (url: string) => void; timeoutMs?: number }): Promise<string> {
  const client = readClient(paths.clientFile);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  return new Promise((ok, fail) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") return void res.writeHead(404).end();
      const done = (status: number, text: string) => res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
      try {
        if (url.searchParams.get("state") !== state) throw new Error("state mismatch");
        const err = url.searchParams.get("error");
        if (err) throw new Error(`consent was not given (${err})`);
        const code = url.searchParams.get("code");
        if (!code) throw new Error("no authorization code in the redirect");
        const t = await tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri(),
        });
        if (!t.refresh_token) throw new Error("Google returned no refresh token");
        writeFileSync(paths.tokenFile, JSON.stringify({ refresh_token: t.refresh_token, scope: t.scope, obtained_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
        done(200, "Resumetron can now read and send mail for this account. You can close this tab.");
        ok(paths.tokenFile);
      } catch (e) {
        done(400, `Authorization failed: ${e instanceof Error ? e.message : String(e)}`);
        fail(e);
      } finally {
        clearTimeout(timer);
        server.close();
      }
    });
    const redirectUri = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const timer = setTimeout(() => {
      server.close();
      fail(new Error("timed out waiting for consent"));
    }, opts.timeoutMs ?? 15 * 60_000);
    server.listen(0, "127.0.0.1", () => opts.show(consentUrl(client, redirectUri(), challenge, state, opts.loginHint)));
  });
}

/** A source of short-lived access tokens from the stored refresh token, refreshed shortly before expiry. */
export function accessTokens(paths: OAuthPaths): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const client = readClient(paths.clientFile);
    if (!existsSync(paths.tokenFile)) throw new Error(`not authorized yet: run \`resumetron email authorize\` (${paths.tokenFile} is missing)`);
    const { refresh_token } = JSON.parse(readFileSync(paths.tokenFile, "utf8"));
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token, client_id: client.clientId, client_secret: client.clientSecret });
    cached = { token: t.access_token, until: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000 };
    return cached.token;
  };
}
