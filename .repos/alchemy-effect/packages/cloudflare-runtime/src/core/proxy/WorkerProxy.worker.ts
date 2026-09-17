import { DurableObject } from "cloudflare:workers";
import * as Schema from "effect/Schema";

interface Env {
  PROXY: ColoLocalActorNamespace;
  PROXY_TOKEN: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.PROXY.get("global").fetch(request);
  },
};

export class WorkerProxy extends DurableObject<Env> {
  target?: URL;
  requestQueue = new Map<Request, PromiseWithResolvers<Response>>();
  retryRequestQueue = new Map<Request, PromiseWithResolvers<Response>>();

  async fetch(request: Request) {
    try {
      if (isProxyControllerRequest(request, this.env)) {
        return await this.handleProxyControllerRequest(request);
      }
      return await this.handleUserWorkerRequest(request);
    } catch (error) {
      return ProxyError.from(error).toResponse();
    }
  }

  private async handleProxyControllerRequest(
    request: Request,
  ): Promise<Response> {
    switch (request.method) {
      case "PUT": {
        this.target = await extractTargetFromRequest(request);
        this.processRequestQueue();
        return new Response(null, { status: 204 });
      }
      case "DELETE": {
        this.target = undefined;
        return new Response(null, { status: 204 });
      }
      default: {
        throw new ProxyError({
          message: "Method not allowed",
          hint: `Expected PUT or DELETE but got ${request.method}.`,
          status: 405,
        });
      }
    }
  }

  private async handleUserWorkerRequest(request: Request): Promise<Response> {
    const promise = Promise.withResolvers<Response>();
    this.requestQueue.set(request, promise);
    this.processRequestQueue();
    return await promise.promise;
  }

  private async processRequestQueue() {
    const target = this.target;
    if (!target) return;
    for (const [request, promise] of this.getOrderedRequestQueue()) {
      this.requestQueue.delete(request);
      this.retryRequestQueue.delete(request);
      void this.routeUserWorkerRequest(request, target)
        .then(promise.resolve)
        .catch((cause) => {
          const error = ProxyError.from(cause);
          if (error.retryable) {
            this.retryRequestQueue.set(request, promise);
            // A request is only retryable when the target moved while it
            // was in flight (the worker restarted), so the NEW target is
            // already set — drive the queue now. Waiting for the next PUT
            // or the next incoming request parks this one indefinitely: a
            // client that is itself waiting on it never sends another, the
            // runtime's hang detector eventually cancels the stalled DO
            // call, and the client gets no response at all.
            this.processRequestQueue();
          } else {
            promise.resolve(error.toResponse());
          }
        });
    }
  }

  private *getOrderedRequestQueue() {
    yield* this.retryRequestQueue;
    yield* this.requestQueue;
  }

  private async routeUserWorkerRequest(
    request: Request,
    target: URL,
  ): Promise<Response> {
    const original = new URL(request.url);
    try {
      // This used to be new URL(original.pathname + original.search, target);
      // but that caused a bug where requests with a path beginning in // were
      // treated as protocol-relative URLs.
      const proxied = new URL(target);
      proxied.pathname = original.pathname;
      proxied.search = original.search;
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-host", original.host);
      headers.set("x-forwarded-proto", original.protocol.replace(/:$/, ""));
      return await fetch(proxied, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch (error) {
      if (!this.target || this.target.href === target.href) {
        throw new ProxyError({
          message: `Failed to fetch worker (upstream address: ${target})`,
          status: 502,
          cause: error,
        });
      }
      throw new ProxyError({
        message: "Your worker restarted mid-request.",
        hint: "Try sending the request again. Only GET and HEAD requests are retried automatically.",
        status: 503,
        retryable: request.method === "GET" || request.method === "HEAD",
        cause: error,
      });
    }
  }
}

class ProxyError extends Schema.TaggedError<ProxyError>()("ProxyError", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect({ includeStack: true })),
}) {
  static from = (error: unknown) =>
    error instanceof ProxyError
      ? error
      : new ProxyError({
          message: "An unknown error occurred",
          cause: error,
        });

  static encode = Schema.encodeSync(ProxyError);

  toResponse(): Response {
    return Response.json(
      {
        ok: false,
        error: ProxyError.encode(this),
      },
      {
        status: this.status ?? 500,
        headers: this.retryable ? { "retry-after": "0" } : undefined,
      },
    );
  }
}

const isProxyControllerRequest = (
  request: Request,
  env: Pick<Env, "PROXY_TOKEN">,
): boolean => {
  const url = new URL(request.url);
  if (url.pathname === "/cdn-cgi/proxy/controller") {
    const token = request.headers.get("authorization")?.split(" ")[1];
    if (!token || !isTimingSafeEqual(token, env.PROXY_TOKEN)) {
      throw new ProxyError({
        message: "Proxy authorization failed",
        hint: "The secret is incorrect.",
        status: 401,
      });
    }
    return true;
  }
  return false;
};

const isTimingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
};

const extractTargetFromRequest = async (request: Request): Promise<URL> => {
  try {
    return new URL(await request.text());
  } catch (error) {
    throw new ProxyError({
      message: "Invalid target",
      hint: "The target is not a valid URL.",
      status: 400,
      cause: error,
    });
  }
};
