import type * as cf from "@cloudflare/workers-types";
import * as Http from "alchemy/Http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectHttp from "effect/http/HttpEffect";
import { ClientAbort } from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Request } from "./Request.ts";
import type { WorkerServices } from "./Worker.ts";
import { isWorkerEvent } from "./WorkerRuntime.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler, event.context)
      : undefined;

export const makeRequestEffect = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
  /** A Worker fetch's context. With it, a client abort interrupts the handler. */
  ctx?: cf.ExecutionContext,
) => {
  const signal = ctx && (webRequest as any as globalThis.Request).signal;
  const safeHandler = Http.safeHttpEffect(handler);
  return Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(webRequest as any as globalThis.Request).modify({
      remoteAddress: Option.fromUndefinedOr(
        webRequest.headers.get("cf-connecting-ip") ?? undefined,
      ),
    });

    Object.defineProperty(request, "raw", {
      get: () =>
        Object.assign(request.stream, {
          raw: webRequest.body,
        }),
    });

    // `toHandled` runs the request uninterruptibly; the handler opts back in,
    // as `HttpRouter` routes do, so a client abort reaches it.
    return yield* toHandledWebResponse(
      signal ? Effect.interruptible(safeHandler) : safeHandler,
    ).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }).pipe(interruptOnClientAbort(signal, ctx)) as any;
};

/**
 * Interrupts the request fiber when the client disconnects, as Effect's
 * `HttpEffect.toWebHandler` does, annotated with `ClientAbort` so
 * `causeResponse` answers 499. The signal only fires under the
 * `enable_request_signal` compatibility flag.
 *
 * workerd cancels the event's pending I/O once the client is gone, so the
 * abort also registers the fiber with `waitUntil`, letting the handler's
 * finalizers finish.
 */
const interruptOnClientAbort =
  (signal: AbortSignal | undefined, ctx: cf.ExecutionContext | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    signal === undefined || ctx === undefined
      ? self
      : Effect.withFiber((fiber) => {
          const onAbort = () => {
            ctx.waitUntil(new Promise<void>((resolve) => fiber.addObserver(() => resolve())));
            fiber.interruptUnsafe(undefined, ClientAbort.annotation);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
            fiber.addObserver(() => signal.removeEventListener("abort", onAbort));
          }
          return self;
        });

const toHandledWebResponse = <Req>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
) =>
  Effect.gen(function* () {
    // `toHandled` exposes the final response through this callback, not its
    // return value. Keep the assignment isolated here so callers get Response.
    const context = yield* Effect.context();
    const webResponse = yield* Deferred.make<Response>();

    yield* EffectHttp.toHandled(handler, (request, response) => {
      const withoutBody = request.method === "HEAD";
      if (!HttpServerResponse.omitsBody(response, withoutBody)) {
        response = EffectHttp.scopeTransferToStream(response);
      }
      return Deferred.succeed(
        webResponse,
        HttpServerResponse.toWeb(response, { withoutBody, context }),
      );
    });
    return yield* Deferred.await(webResponse);
  });

export { isScopeEjected } from "alchemy/Http";
