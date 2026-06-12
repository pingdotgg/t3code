import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export type HttpEffect<Req = never> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError | HttpBodyError,
  HttpServerRequest | Scope | Req
>;

export const serve = <Req = never>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | HttpBodyError,
    HttpServerRequest | Scope | Req
  >,
) =>
  Effect.serviceOption(HttpServer).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((http) => (http ? http.serve(handler) : Effect.void)),
  );

export class HttpServer extends Context.Service<
  HttpServer,
  {
    serve: <Req = never>(
      handler: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        HttpServerError | HttpBodyError,
        Req
      >,
      options?: {
        port?: number;
      },
    ) => Effect.Effect<void, never, Exclude<Req, HttpServerRequest> | Scope>;
  }
>()("HttpServer") {}

export const safeHttpEffect = <Req = never>(
  handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Req | HttpServerRequest | Scope
> =>
  Effect.catchCause(
    handler.pipe(
      // @ts-expect-error
      Effect.flatMap((response) =>
        HttpServerResponse.isHttpServerResponse(response)
          ? Effect.succeed(response)
          : response,
      ),
    ) as any as HttpEffect<Req>,
    (cause) => {
      // ClientAbort interrupts are not real failures — the client closed
      // the connection. Skip logging and respond with 499 if applicable.
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.succeed(HttpServerResponse.empty({ status: 499 }));
      }
      // Log the full cause server-side so operators can debug, but return
      // a generic 500 to the client. Causes can contain sensitive data
      // (prompt contents, API keys baked into error messages, internal
      // file paths) and should never be echoed back to the network.
      return Effect.logError("HTTP handler failed", cause).pipe(
        Effect.as(
          HttpServerResponse.text("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );
    },
  );

export const resolvePort = (options: { port?: number } | undefined) =>
  options?.port !== undefined
    ? Effect.succeed(options.port)
    : Config.number("PORT").pipe(Config.withDefault(3000));

export const BunHttpServer = () =>
  Layer.effect(
    HttpServer,
    Effect.gen(function* () {
      const BunHttpServerPlatform = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return {
        serve: (handler, options) =>
          Effect.gen(function* () {
            const port = yield* resolvePort(options);
            const server = yield* BunHttpServerPlatform.make({ port });
            yield* server.serve(safeHttpEffect(handler));
          }).pipe(Effect.orDie),
      };
    }),
  );

export const NodeHttpServer = () =>
  Layer.effect(
    HttpServer,
    Effect.gen(function* () {
      const NodeHttpServerPlatform = yield* Effect.promise(
        () => import("@effect/platform-node/NodeHttpServer"),
      );
      const NodeHttp = yield* Effect.promise(() => import("node:http"));
      return {
        serve: (handler, options) =>
          Effect.gen(function* () {
            const port = yield* resolvePort(options);
            const server = yield* NodeHttpServerPlatform.make(
              NodeHttp.createServer,
              { port },
            );
            yield* server.serve(safeHttpEffect(handler));
          }).pipe(Effect.orDie),
      };
    }),
  );
