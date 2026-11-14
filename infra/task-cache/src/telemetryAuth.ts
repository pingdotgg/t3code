import { decodeJwt, type JWTVerifyGetKey } from "jose";
import { authorize } from "../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts";
import type { Scope } from "../vendor/vite-plus-remote-cache-cloudflare/src/database.ts";
import { HttpError } from "../vendor/vite-plus-remote-cache-cloudflare/src/errors.ts";

function audienceScope(request: Request, scope: Scope, telemetry = false) {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16 * 1024) throw new HttpError(401, "invalid_token");
  let payload;
  try {
    payload = decodeJwt(authorization.slice(7));
  } catch {
    throw new HttpError(401, "invalid_token");
  }
  // The decoded base only selects policy; authorize verifies all claims and the signature.
  const branch =
    telemetry && payload.event_name === "pull_request" && typeof payload.base_ref === "string"
      ? `refs/heads/${payload.base_ref}`
      : scope.branch;
  let endpoint = scope.endpoint;
  if (typeof payload.aud === "string") {
    try {
      const audience = new URL(payload.aud);
      audience.username = "";
      audience.password = "";
      // Vite+ uses the configured URL, including read credentials, as its OIDC audience.
      if (audience.href.replace(/\/$/, "") === scope.endpoint.replace(/\/$/, ""))
        endpoint = payload.aud;
    } catch {
      // The verified authorization below rejects malformed and foreign audiences.
    }
  }
  return { ...scope, branch, endpoint, pull_requests: telemetry ? 1 : scope.pull_requests };
}

export async function authorizeCacheWrite(request: Request, scope: Scope, keys: JWTVerifyGetKey) {
  return authorize(request, audienceScope(request, scope), keys);
}

export async function authorizeTelemetry(request: Request, scope: Scope, keys: JWTVerifyGetKey) {
  await authorize(request, audienceScope(request, { ...scope, writes_enabled: 1 }, true), keys);
  const payload = decodeJwt(request.headers.get("authorization")!.slice(7));
  return `github/${typeof payload.actor === "string" ? payload.actor : "unknown"}`;
}
