// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";
import { codexAuthorizationRequest, codexCallbackUrl } from "@t3tools/shared/codexAuthHandoff";

export class CodexAuthCallbackError extends Schema.TaggedError<CodexAuthCallbackError>()(
  "CodexAuthCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const listeners = new Map<string, AbortController>();

export function cancelCodexAuthCallback(authorizationUrl: string) {
  const { state } = codexAuthorizationRequest(authorizationUrl);
  listeners.get(state)?.abort();
}

/** Receive an authorization code locally. Credentials and PKCE stay on the target environment. */
export async function receiveCodexAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  destination?: (callbackUrl: string) => string,
  signal?: AbortSignal,
) {
  const request = codexAuthorizationRequest(authorizationUrl);
  if (listeners.has(request.state))
    throw new Error("This sign-in is already open on this computer.");
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  signal?.addEventListener("abort", interrupted, { once: true });
  listeners.set(request.state, abort);
  const callback = Promise.withResolvers<string>();
  // Keep early open/bind failures from leaving an unobserved rejection behind.
  void callback.promise.catch(() => undefined);
  const server = NodeHttp.createServer((incoming, response) => {
    try {
      if (incoming.method !== "GET") throw new Error("method");
      const url = codexCallbackUrl(
        new URL(incoming.url ?? "/", request.redirectUri).toString(),
        request.redirectUri,
        request.state,
      ).toString();
      const returnUrl = destination?.(url);
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      if (returnUrl) {
        response.writeHead(303, { location: returnUrl }).end();
      } else {
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        );
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to T3 Code</h1><p>Your sign-in response has been received. T3 Code is finishing the connection. You can close this tab.</p></main></body></html>',
          );
      }
      callback.resolve(url);
    } catch {
      response.writeHead(400).end("This response does not belong to the active sign-in.");
    }
  });
  const cancelled = () => callback.reject(new Error("Sign-in cancelled on this computer."));
  abort.signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(
    () => callback.reject(new Error("Sign-in expired. Try again.")),
    300_000,
  );
  timer.unref();
  try {
    if (signal?.aborted) throw new Error("Sign-in cancelled on this computer.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", () =>
        reject(
          new Error(
            "The ChatGPT callback port is in use on this computer. Close the other sign-in and try again, or paste the redirect URL in T3 Code.",
          ),
        ),
      );
      server.listen(Number(new URL(request.redirectUri).port), "127.0.0.1", resolve);
    });
    if (abort.signal.aborted) throw new Error("Sign-in cancelled on this computer.");
    if (!(await openBrowser(request.authorizationUrl)))
      throw new Error("Could not open your sign-in browser.");
    return await callback.promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupted);
    abort.signal.removeEventListener("abort", cancelled);
    listeners.delete(request.state);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
