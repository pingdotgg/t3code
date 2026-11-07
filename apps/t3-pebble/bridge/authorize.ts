import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const origin = process.env.T3_ORIGIN;
if (!origin) throw new Error("Set T3_ORIGIN to the T3 Code server origin");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(32).toString("base64url");
let finish!: (result: { code?: string; error?: string }) => void;
const result = new Promise<{ code?: string; error?: string }>((resolve) => { finish = resolve; });
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) return new Response("Invalid sign-in", { status: 400 });
  finish({ code: url.searchParams.get("code") ?? undefined, error: url.searchParams.get("error") ?? undefined });
  return new Response("You can close this window.");
}});
try {
  const redirect = `http://127.0.0.1:${listener.port}/callback`;
  const registration = await fetch(`${origin}/oauth/mcp/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "T3 Pebble", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
  const { client_id } = await registration.json();
  const url = new URL(`${origin}/oauth/mcp/authorize`);
  for (const [key, value] of Object.entries({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource: `${origin}/mcp` })) url.searchParams.set(key, value);
  console.log(`Open this URL and approve T3 Pebble:\n${url}`);
  const authorization = await result;
  if (!authorization.code) throw new Error(`Authorization failed: ${authorization.error ?? "missing code"}`);
  const response = await fetch(`${origin}/oauth/mcp/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: authorization.code, redirect_uri: redirect, client_id, code_verifier: verifier, resource: `${origin}/mcp` }) });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
  const token = await response.json();
  await writeFile(".mcp-token", token.access_token, { mode: 0o600 });
  console.log(`Authorized. Token expires in ${token.expires_in} seconds.`);
} finally { listener.stop(true); }
