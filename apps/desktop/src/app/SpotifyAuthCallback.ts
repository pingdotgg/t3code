// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener.
import * as NodeHttp from "node:http";

/** Must match the Redirect URI registered on the Spotify app, byte for byte. */
const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8898/callback";

export function spotifyAuthorizationRequest(value: string) {
  const url = new URL(value);
  const state = url.searchParams.get("state") ?? "";
  if (
    url.origin !== "https://accounts.spotify.com" ||
    url.pathname !== "/authorize" ||
    url.searchParams.get("redirect_uri") !== SPOTIFY_REDIRECT_URI ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[\w-]{16,128}$/u.test(state)
  ) {
    throw new Error("Invalid Spotify sign-in request.");
  }
  return { authorizationUrl: url.toString(), state };
}

const PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Xen Code</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh"><main><h1>Spotify connected</h1><p>You can close this tab and return to Xen Code.</p></main></body>';

/** Opens Spotify sign-in in the browser and resolves with the redirect URL it lands on. */
export async function receiveSpotifyAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
): Promise<string> {
  const request = spotifyAuthorizationRequest(authorizationUrl);
  const callback = Promise.withResolvers<string>();
  void callback.promise.catch(() => undefined);
  const server = NodeHttp.createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", SPOTIFY_REDIRECT_URI);
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== request.state) {
      response.writeHead(400).end("This response does not belong to the active sign-in.");
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    callback.resolve(url.toString());
  });
  const timer = setTimeout(
    () => callback.reject(new Error("Sign-in expired. Try again.")),
    300_000,
  );
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () =>
        reject(new Error("Port 8898 is in use. Close the other sign-in and try again.")),
      );
      server.listen(8898, "127.0.0.1", resolve);
    });
    if (!(await openBrowser(request.authorizationUrl))) {
      throw new Error("Could not open your browser.");
    }
    return await callback.promise;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
