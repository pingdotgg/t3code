import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  HttpClientError,
  TransportError,
} from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

export type SocketAddress = cf.SocketAddress;

export type SocketOptions = cf.SocketOptions;

/**
 * Whether a native Web `Headers` and an Effect headers record carry the
 * same entries. Lets {@link makeFetcher} keep forwarding the platform's
 * own request object when `request.modify` left the headers unchanged,
 * and rebuild only when they genuinely differ. Effect header keys are
 * already lowercased and `Headers.get` is case-insensitive, so the
 * comparison needs no normalization.
 */
const sameHeaders = (
  web: Headers,
  eff: Readonly<Record<string, string>>,
): boolean => {
  const keys = Object.keys(eff);
  let webCount = 0;
  for (const _ of web.keys()) {
    webCount++;
    if (webCount > keys.length) return false;
  }
  if (webCount !== keys.length) return false;
  for (const key of keys) {
    if (web.get(key) !== eff[key]) return false;
  }
  return true;
};

export interface Fetcher {
  raw: cf.Fetcher;
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;

  connect(
    address: SocketAddress | string,
    options?: SocketOptions,
  ): Socket.Socket;
}

export const toCloudflareFetcher = Effect.fn(function* (fetcher: Fetcher) {
  const context = yield* Effect.context();
  return {
    fetch: (input, init) =>
      fetcher
        .fetch(
          HttpServerRequest.fromWeb(
            new Request(input as any, init as any) as any as Request,
          ),
        )
        .pipe(
          Effect.map(
            (response) =>
              HttpServerResponse.toWeb(response, {
                context,
              }) as any as cf.Response,
          ),
          Effect.provideContext(context),
          Effect.runPromise,
        ),
    connect() {
      // TODO
      throw new Error("toCloudflareFetcher does not support connect()");
    },
  } satisfies cf.Fetcher;
});

export const fromCloudflareFetcher = (
  fetcher: cf.Fetcher | globalThis.Fetcher,
): Fetcher => {
  const fetch = (request: Request) =>
    Effect.suspend(() => {
      // Clone per attempt, keeping `request` pristine: the HandlerNotReady
      // retry below re-runs this suspend, and replaying a Request whose body
      // the failed attempt already consumed makes workerd reject with
      // "TypeError: Cannot reconstruct a Request with a used body".
      const attempt = request.clone() as Request;
      return Effect.promise((signal) =>
        (fetcher as globalThis.Fetcher).fetch(attempt, {
          signal: signal,
        }),
      );
    }).pipe(
      // The "Handler does not export a fetch()" window is a property of
      // invoking a freshly-deployed Cloudflare binding, so it is ridden out
      // HERE — the one adapter every binding flows through — rather than in any
      // single higher-level wrapper (`toHttpClient`, the client/server
      // overloads, the RPC DO transport all go through this). `Effect.promise`
      // surfaces the rejection as a defect; lift it to a typed retryable error
      // and back off until the new version propagates. The request never
      // reached a handler, so nothing committed — safe to retry. This wraps
      // only the promise, leaving the response (and its streaming body)
      // untouched, so RPC/stream decoding is unaffected. After the budget is
      // exhausted, re-raise the original defect unchanged.
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause);
        return isHandlerNotReady(squashed)
          ? Effect.fail(new HandlerNotReady(squashed))
          : Effect.failCause(cause);
      }),
      Effect.retry({
        while: (error) => error instanceof HandlerNotReady,
        schedule: Schedule.exponential("100 millis"),
        times: 8,
      }),
      Effect.catch((error) =>
        error instanceof HandlerNotReady
          ? Effect.die(error.cause)
          : Effect.failCause(Cause.fail(error)),
      ),
    );

  return {
    raw: fetcher as cf.Fetcher,
    connect: (address, options) =>
      fromCloudflareSocket(fetcher.connect(address, options)),
    fetch: (
      request:
        | HttpClientRequest.HttpClientRequest
        | HttpServerRequest.HttpServerRequest,
    ): any =>
      HttpClientRequest.isHttpClientRequest(request)
        ? pipe(
            HttpServerRequest.toWeb(
              HttpServerRequest.fromClientRequest(request),
            ),
            Effect.flatMap(fetch),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, response as any as Response),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(error.message, {
                    status:
                      error._tag === "InternalError"
                        ? 500
                        : error._tag === "RequestParseError"
                          ? 400
                          : 404,
                  }),
                ),
              ),
            ),
          )
        : pipe(
            HttpServerRequest.toWeb(request),
            // `toWeb` hands back the raw native request untouched whenever
            // there is one (always, on workerd) — the fast path we WANT:
            // it forwards the platform's own edge request instead of
            // cloning it. The catch is that it also ignores header
            // overrides from `request.modify({ headers })`, so a caller
            // that strips or mints an internal header before forwarding
            // (e.g. a Worker sanitizing a trust header for its Durable
            // Object) would be silently dropped. Rebuild ONLY when the
            // effect request's headers actually differ from the native
            // request's; an unmodified forward (or a modify that was a
            // no-op) stays on the metal. `new Request(req, init)`
            // preserves the method and un-consumed streaming body.
            Effect.map((webRequest) =>
              sameHeaders(webRequest.headers, request.headers)
                ? webRequest
                : new Request(webRequest, {
                    headers: request.headers as Record<string, string>,
                  }),
            ),
            Effect.flatMap(fetch),
            Effect.map((response) => {
              if ((response as any).status === 101) {
                return HttpServerResponse.setBody(
                  HttpServerResponse.empty({ status: 101 }),
                  HttpBody.raw(response),
                );
              }
              return HttpServerResponse.fromWeb(response as any as Response);
            }),
          ),
  };
};

/**
 * A freshly-deployed Durable Object / service script is eventually consistent:
 * for a short window after deploy, workerd can route a `.fetch()` to a stale
 * script version whose class has no fetch handler yet, surfacing as
 * "Handler does not export a fetch() function." It clears within seconds once
 * the new version propagates, so it is safe to retry.
 */
const isHandlerNotReady = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown } | null)?.message === "string"
          ? ((error as { message: string }).message as string)
          : "";
  return message.includes("does not export a fetch");
};

/**
 * Adapt anything that exposes a server-shaped `fetch` (e.g. a Durable Object
 * stub, a Worker service binding) into an Effect `HttpClient`. Lets HttpApi
 * clients address bindings without a base URL via `transformClient`.
 */
class HandlerNotReady {
  readonly _tag = "HandlerNotReady";
  constructor(readonly cause: unknown) {}
}

export const toHttpClient = (fetcher: {
  fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;
}) =>
  HttpClient.make((request) => {
    return Effect.suspend(() =>
      // Rebuild the server request on every attempt so a retry re-serializes
      // the body instead of replaying a consumed one.
      fetcher
        .fetch(HttpServerRequest.fromClientRequest(request))
        .pipe(
          Effect.map((response) =>
            HttpClientResponse.fromWeb(
              request,
              HttpServerResponse.toWeb(response),
            ),
          ),
        ),
    ).pipe(
      // The handler-not-ready window is already ridden out at the lowest level
      // (the `fromCloudflareFetcher` promise retries `HandlerNotReady` before
      // it ever reaches here). A `HandlerNotReady` still surfacing means the
      // budget was exhausted — it arrives as a defect (re-raised rejected
      // promise), so convert it (and any other failure cause) into a typed
      // transport error rather than retrying again.
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause);
        return Effect.fail(
          new HttpClientError({
            reason: new TransportError({
              request,
              cause: isHandlerNotReady(squashed)
                ? (squashed as { message?: unknown })
                : squashed,
              description: "Fetcher-backed HttpClient request failed",
            }),
          }),
        );
      }),
    );
  });

export const fromCloudflareSocket = (
  cfSocket: globalThis.Socket | cf.Socket,
): Socket.Socket =>
  // `fromTransformStream` snapshots fiber context, then waits to acquire
  // the streams until a consumer opens the reader. `runSync` is only that
  // snapshot — connection still happens on first `socket.reader`.
  Effect.runSync(
    Socket.fromTransformStream(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(cfSocket.opened).then(
            () =>
              ({
                readable: cfSocket.readable,
                writable: cfSocket.writable,
              }) as Socket.InputTransformStream,
          ),
        catch: (cause) =>
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({
              kind: "Unknown",
              cause,
            }),
          }),
      }),
    ),
  );
