import type * as cf from "@cloudflare/workers-types";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(
    handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
  ) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler)
      : undefined;

export const makeRequestEffect = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      webRequest as any as globalThis.Request,
    ).modify({
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

    return yield* toHandledWebResponse(safeHandler).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }) as any;
};

const toHandledWebResponse = <Req>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
) =>
  Effect.gen(function* () {
    // `toHandled` exposes the final response through this callback, not its
    // return value. Keep the assignment isolated here so callers get Response.
    const context = yield* Effect.context();
    const webResponse = yield* Deferred.make<Response>();

    yield* EffectHttp.toHandled(handler, (request, response) =>
      Deferred.succeed(
        webResponse,
        // Conversion to web response with options matches `EffectHttp.toWebHandler`'s callback.
        HttpServerResponse.toWeb(EffectHttp.scopeTransferToStream(response), {
          withoutBody: request.method === "HEAD",
          context,
        }),
      ),
    );
    return yield* Deferred.await(webResponse);
  });

const scopeEjected = Symbol.for("effect/http/HttpEffect/scopeEjected");

export const isScopeEjected = (scope: Scope.Scope) => scopeEjected in scope;
