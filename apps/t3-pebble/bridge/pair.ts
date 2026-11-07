import { createHash, randomBytes } from "node:crypto";

export async function pair(origin: string, pairingCode: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const redirect = "http://127.0.0.1/callback";
  const resource = `${origin}/mcp`;
  const post = async (path: string, body: BodyInit, contentType: string) => {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": contentType }, body });
    if (!response.ok) throw new Error("Pairing failed. Check the code and its permissions.");
    return response.json();
  };
  const client = await post("/oauth/mcp/register", JSON.stringify({ client_name: "T3 Pebble", redirect_uris: [redirect], token_endpoint_auth_method: "none" }), "application/json");
  const authorization = { response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource };
  const approval = await post("/oauth/mcp/decision", JSON.stringify({ authorization, decision: { _tag: "pairing-code", access: "full-access", code: pairingCode } }), "application/json");
  const callback = new URL(approval.redirectTo);
  if (callback.origin !== "http://127.0.0.1" || callback.pathname !== "/callback" || callback.searchParams.get("state") !== state) throw new Error("Invalid pairing response");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Pairing was not approved");
  const token = await post("/oauth/mcp/token", new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource }), "application/x-www-form-urlencoded");
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Invalid pairing response");
  return token.access_token as string;
}
