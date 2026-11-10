/**
 * Remote queue producer forwarder.
 *
 * workerd's `queue` binding speaks the queue wire protocol to its designated
 * service (`POST /message` with raw bytes + `X-Msg-Fmt`, `POST /batch` with
 * base64 payloads). Cloudflare's preview/remote-binding sessions do not
 * support queue bindings at all, so a remote producer instead targets a
 * REAL deployed shim worker that holds the actual queue binding and decodes
 * the wire protocol back into `send()`/`sendBatch()` calls.
 *
 * This service is the local half of that pair: a pass-through proxy that
 * forwards the wire-protocol request to the shim over HTTPS, authenticated
 * with a bearer token minted for the shim at deploy time.
 */
interface Env {
  SHIM_URL: string;
  SHIM_TOKEN: string;
}

/**
 * Statuses worth retrying: a freshly deployed shim's workers.dev subdomain
 * serves 404/503 (and Cloudflare 52x) for a few seconds while it
 * propagates. Bounded backoff keeps the first sends of a dev session from
 * erroring instead of delivering.
 */
const RETRYABLE = new Set([404, 503, 521, 522, 523]);
const MAX_ATTEMPTS = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.SHIM_URL);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${env.SHIM_TOKEN}`);
    // The body may be replayed on retry — buffer it up front.
    const body = await request.arrayBuffer();
    let response: Response | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
      response = await fetch(target, {
        method: request.method,
        headers,
        body,
      });
      if (!RETRYABLE.has(response.status)) {
        return response;
      }
    }
    return response!;
  },
} satisfies ExportedHandler<Env>;
