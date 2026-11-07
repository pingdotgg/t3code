import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { pair } from "./pair.ts";

test("exchanges the pairing code using a verified PKCE authorization", async () => {
  let challenge = "", state = "";
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/register")) return Response.json({ client_id: "client" });
    if (path.endsWith("/decision")) {
      const body = await request.json();
      expect(body.decision).toEqual({ _tag: "pairing-code", access: "full-access", code: "pair-code" });
      challenge = body.authorization.code_challenge; state = body.authorization.state;
      return Response.json({ redirectTo: `http://127.0.0.1/callback?code=approved&state=${state}` });
    }
    const body = new URLSearchParams(await request.text());
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge);
    expect(body.get("code")).toBe("approved");
    return Response.json({ access_token: "mcp-token" });
  }});
  try { expect(await pair(`http://127.0.0.1:${upstream.port}`, "pair-code")).toBe("mcp-token"); }
  finally { upstream.stop(true); }
});
