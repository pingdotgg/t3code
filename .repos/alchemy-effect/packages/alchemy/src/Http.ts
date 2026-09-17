import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import {
  causeResponse,
  type HttpServerError,
} from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export type HttpEffect<Req = never> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError | HttpBodyError,
  HttpServerRequest | Scope | Req
>;

/**
 * `effect`'s HttpEffect brands a request scope as "ejected" when ownership
 * is transferred to a consumer that outlives the handler's return — a
 * streaming response body, a WebSocket upgrade, an RPC stream. Bridges check
 * this before their close-on-return path: an ejected scope is closed by its
 * new owner when it finishes, not by the bridge.
 */
const scopeEjected = Symbol.for("effect/http/HttpEffect/scopeEjected");

export const isScopeEjected = (scope: Scope) => scopeEjected in scope;

export const serve = <Req = never>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | HttpBodyError,
    HttpServerRequest | Scope | Req
  >,
) =>
  Effect.serviceOption(HttpServer).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((http) =>
      http
        ? // `HttpServer.serve` registers the server on the ambient Scope and
          // RETURNS; the server lives until that scope closes. A host program
          // (ECS task/service, EC2 instance) must therefore park forever after
          // a successful registration — otherwise a pure `{ fetch }` program
          // completes immediately, `Effect.scoped` closes the scope, and the
          // container exits 0 in a crash-loop. (One-shot `{ run }` programs
          // never call `serve`, so they still exit when `run` completes.)
          Effect.andThen(http.serve(handler), Effect.never)
        : Effect.void,
    ),
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
    (cause) =>
      // `causeResponse` is effect's native failure boundary: Respondable
      // failures keep their intended response (e.g. RouteNotFound -> 404),
      // client aborts map to 499, and everything else becomes an empty 500 —
      // the cause is never echoed to the network, as it can contain sensitive
      // data (prompt contents, API keys baked into error messages, internal
      // file paths).
      causeResponse(cause).pipe(
        Effect.flatMap(([response, reportableCause]) =>
          Effect.withFiber((fiber) =>
            fiber.getRef(ErrorReporter.CurrentErrorReporters).size > 0
              ? ErrorReporter.report(reportableCause)
              : logUnreportedCause(reportableCause),
          ).pipe(Effect.as(response)),
        ),
      ),
  );

/**
 * No `ErrorReporter` is registered by default, so without a fallback a defect
 * in a deployed Function/Worker would produce a bare 500 and vanish without a
 * trace. Log the cause server-side so operators can debug, applying the same
 * filtering `ErrorReporter.make` reporters do: interrupts (client aborts) and
 * `ErrorReporter.ignore`-annotated values (Respondable errors like
 * RouteNotFound, and the response `causeResponse` appends) are not failures
 * and are skipped.
 */
const logUnreportedCause = (cause: Cause.Cause<unknown>) => {
  const failures = cause.reasons.filter(
    (reason) =>
      reason._tag !== "Interrupt" &&
      !ErrorReporter.isIgnored(
        reason._tag === "Fail" ? reason.error : reason.defect,
      ),
  );
  return failures.length === 0
    ? Effect.void
    : Effect.logError("HTTP handler failed", Cause.fromReasons(failures));
};

export const resolvePort = (options: { port?: number } | undefined) =>
  options?.port !== undefined
    ? Effect.succeed(options.port)
    : Config.number("PORT").pipe(Config.withDefault(3000));

export interface BunHttpServerOptions {
  /**
   * Network interface on which the Bun HTTP server listens.
   * Omit to use Bun's default.
   */
  hostname?: string;
}

export const BunHttpServer = (serverOptions?: BunHttpServerOptions) =>
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
            const server = yield* BunHttpServerPlatform.make({
              port,
              ...(serverOptions?.hostname === undefined
                ? {}
                : { hostname: serverOptions.hostname }),
            });
            yield* server.serve(safeHttpEffect(handler));
          }).pipe(Effect.orDie),
      };
    }),
  );

export interface NodeHttpServerOptions {
  /**
   * Address the Node HTTP server binds. Fly / Hetzner / Railway machines
   * need `0.0.0.0`; omit to use that default.
   * @default "0.0.0.0"
   */
  hostname?: string;
}

export const NodeHttpServer = (serverOptions?: NodeHttpServerOptions) =>
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
              {
                port,
                host: serverOptions?.hostname ?? "0.0.0.0",
              },
            );
            yield* server.serve(safeHttpEffect(handler));
          }).pipe(Effect.orDie),
      };
    }),
  );
