import { session } from "electron";

export const DEVICE_TRUST_SCHEME = "t3code-device-trust";
export const DEVICE_TRUST_REQUESTS = "http://127.0.0.1/*";
const AUTH_ORIGIN = "https://auth.kolide.com";
const BRIDGE_PREFIX = `${DEVICE_TRUST_SCHEME}://agent`;
const REQUEST_TIMEOUT_MS = 5_000;
// See the vendor's Device Trust troubleshooting guide and the launcher's localserver routes.
const PORTS = new Set(["12519", "40978", "52115", "22287", "60685", "22322"]);
const PATHS = new Set(["/v0/cmd", "/v1/cmd"]);

const agentUrl = (details: Electron.OnBeforeRequestListenerDetails) => {
  if (
    details.initiatorOrigin !== AUTH_ORIGIN ||
    (details.method !== "GET" && details.method !== "POST") ||
    (details.resourceType !== "xhr" && details.resourceType !== "image")
  ) {
    return null;
  }
  const url = URL.parse(details.url);
  return url?.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "" &&
    PORTS.has(url.port) &&
    PATHS.has(url.pathname)
    ? url.href
    : null;
};

let directSession: Promise<Electron.Session> | undefined;
const getDirectSession = () => {
  const client = session.fromPartition(DEVICE_TRUST_SCHEME, { cache: false });
  return client.setProxy({ mode: "direct" }).then(() => client);
};

export const makeDeviceTrustAgent = (newToken: () => string) => {
  const pending = new Map<string, { url: string; method: string; expiresAt: number }>();
  return {
    beforeRequest(
      details: Electron.OnBeforeRequestListenerDetails,
    ): Electron.CallbackResponse | null {
      const url = agentUrl(details);
      if (url === null) return null;
      const now = performance.now();
      for (const [key, { expiresAt }] of pending) {
        if (expiresAt <= now) pending.delete(key);
      }
      if (pending.size >= 64) return { cancel: true };
      const redirectURL = `${BRIDGE_PREFIX}/${newToken()}`;
      pending.set(redirectURL, {
        url,
        method: details.method,
        expiresAt: now + REQUEST_TIMEOUT_MS,
      });
      return { redirectURL };
    },
    async handle(request: Request): Promise<Response> {
      // Consume the redirect once. The original request, not the synthetic URL, passed the page CSP.
      const entry = pending.get(request.url);
      if (
        entry === undefined ||
        entry.expiresAt <= performance.now() ||
        request.method !== entry.method ||
        !("initiatorOrigin" in request) ||
        request.initiatorOrigin !== AUTH_ORIGIN
      ) {
        return Response.error();
      }
      pending.delete(request.url);

      try {
        const client = await (directSession ??= getDirectSession().catch((error: unknown) => {
          directSession = undefined;
          throw error;
        }));
        // Chromium can blank the wire Origin on redirect; the helper checks the original origin.
        const headers = new Headers({ Origin: AUTH_ORIGIN });
        for (const name of ["Accept", "Content-Type", "User-Agent"]) {
          const value = request.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        const init = {
          method: request.method,
          body: request.body,
          duplex: "half",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers,
        } as const;
        const response = await client.fetch(entry.url, init);
        return new Response(response.body, {
          status: response.status,
          headers: {
            "Cache-Control": "no-store",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return Response.error();
      }
    },
  };
};
