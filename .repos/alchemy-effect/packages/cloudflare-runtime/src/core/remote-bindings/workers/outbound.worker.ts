import { DurableObject } from "cloudflare:workers";
import { decodeResponse } from "../../internal/response.shared.ts";
import type {
  RemoteWorkerConfig,
  RemoteWorkerResult,
} from "../RemoteWorkerConfig.shared.ts";

interface Env {
  PROXY: ColoLocalActorNamespace;
  LOOPBACK: Fetcher;
  OPTIONS: RemoteWorkerConfig;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const actor = env.PROXY.get("global");
    return await actor.fetch(request);
  },
};

/**
 * Preview tokens expire after 1 hour (hardcoded in the Workers control
 * plane). Proactively refresh at 50 minutes so no request ever pays for —
 * or worse, surfaces — an expired session. Mirrors wrangler's
 * `PREVIEW_TOKEN_REFRESH_INTERVAL` (workers-sdk #13016).
 */
const SESSION_MAX_AGE_MS = 50 * 60 * 1000;

interface Session {
  readonly config: RemoteWorkerResult;
  readonly createdAt: number;
}

/**
 * An expired/invalidated preview session surfaces in (at least) three
 * shapes:
 *
 *  - HTTP 400 with an HTML body containing "Invalid Workers Preview
 *    configuration" — the classic expired-preview-token page.
 *  - HTTP 400 with a text/plain body containing "error code: 1031" —
 *    returned by remote bindings (D1, R2, Workers AI, ...) when their
 *    underlying session has timed out.
 *  - HTTP 400 from OUR OWN uploaded remote worker: a `BindingNotFound`
 *    ConfigError means the edge routed the preview token to a deployment
 *    with a stale binding set (the edge preview dedupes deployments by
 *    script content and can serve an older deployment's env). A fresh
 *    deploy re-uploads with the current bindings.
 *
 * All mean the cached session must be discarded and recreated. The first
 * two matchers mirror wrangler's `checkForPreviewTokenError`.
 */
async function isStaleSessionResponse(response: Response): Promise<boolean> {
  if (response.status !== 400) {
    return false;
  }
  const text = await response.clone().text();
  return (
    text.includes("Invalid Workers Preview configuration") ||
    text.includes("error code: 1031") ||
    (text.includes('"BindingNotFound"') && text.includes('"ConfigError"'))
  );
}

export class RemoteBindingProxy extends DurableObject<Env> {
  private session: Session | undefined;

  async fetch(request: Request): Promise<Response> {
    const session = await this.configure();
    // The first attempt consumes the request body; keep a clone so a
    // stale-session retry can replay it.
    const retry = request.body ? request.clone() : request;
    const response = await this.proxy(request, session);
    if (await isStaleSessionResponse(response)) {
      const fresh = await this.configure(session);
      return await this.proxy(retry, fresh);
    }
    return response;
  }

  /**
   * Return the cached preview session, deploying a fresh one when there is
   * none, the cached one is older than {@link SESSION_MAX_AGE_MS}, or the
   * caller observed the cached session (`stale`) fail. Passing the failed
   * session makes recovery single-flight: concurrent requests that all hit
   * the same expired session share one redeploy instead of each minting a
   * new preview session.
   */
  private configure(stale?: Session): Promise<Session> {
    const cached = this.session;
    if (cached && this.isUsable(cached, stale)) {
      return Promise.resolve(cached);
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      // Re-check under the lock: a concurrent request may have already
      // refreshed the session while we were waiting.
      const current = this.session;
      if (current && this.isUsable(current, stale)) {
        return current;
      }
      this.session = undefined;
      const response = await this.env.LOOPBACK.fetch("http://stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.env.OPTIONS),
      });
      const config = await decodeResponse<RemoteWorkerResult>(response);
      const session: Session = { config, createdAt: Date.now() };
      this.session = session;
      return session;
    });
  }

  private isUsable(session: Session, stale: Session | undefined): boolean {
    return (
      session !== stale && Date.now() - session.createdAt < SESSION_MAX_AGE_MS
    );
  }

  private async proxy(request: Request, session: Session): Promise<Response> {
    const origin = new URL(request.url);
    const target = new URL(origin.pathname + origin.search, session.config.url);
    const proxiedHeaders = new Headers(request.headers);
    for (const [key, value] of Object.entries(session.config.headers)) {
      proxiedHeaders.set(key, value);
    }
    return await fetch(
      target,
      new Request(request, { headers: proxiedHeaders }),
    );
  }
}
