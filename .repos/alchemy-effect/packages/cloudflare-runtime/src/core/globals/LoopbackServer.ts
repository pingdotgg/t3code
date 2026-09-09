import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { isRuntimeError, SystemError } from "../RuntimeError.shared.ts";
import { getAddress } from "../internal/get-address.ts";
import { makeErrorEnvelope } from "../internal/response.shared.ts";

export class LoopbackServer extends Context.Service<
  LoopbackServer,
  {
    readonly address: string;
    readonly secret: string;
    readonly route: (
      name: string,
      handler: RouteHandler,
    ) => Effect.Effect<void>;
  }
>()("cloudflare-runtime/LoopbackServer") {}

export type EffectHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  any,
  HttpServerRequest.HttpServerRequest
>;
export type RawHandler = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => void | Promise<void>;
export type RouteHandler = EffectHandler | RawHandler;

export const LoopbackServerHeaders = {
  TARGET: "loopback-target",
  SECRET: "loopback-secret",
} as const;

export const LoopbackServerLive = Layer.effect(
  LoopbackServer,
  Effect.gen(function* () {
    const routes = MutableHashMap.empty<string, RawHandler>();
    const secret = crypto.randomUUID();
    const server = yield* Effect.sync(() =>
      NodeHttp.createServer(async (req, res) => {
        const secretHeader = req.headers[LoopbackServerHeaders.SECRET] as
          | string
          | undefined;
        const targetHeader = req.headers[LoopbackServerHeaders.TARGET] as
          | string
          | undefined;

        if (!secretHeader) {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "BadRequest",
              message: `The "${LoopbackServerHeaders.SECRET}" header is required.`,
            }),
            400,
          );
        } else if (!targetHeader) {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "BadRequest",
              message: `The "${LoopbackServerHeaders.TARGET}" header is required.`,
            }),
            400,
          );
        } else if (!timingSafeEqual(secretHeader, secret)) {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "Unauthorized",
              message: "Unauthorized",
            }),
            401,
          );
        }

        const route = MutableHashMap.get(routes, targetHeader);

        if (route._tag === "None") {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "NotFound",
              message: `The route "${targetHeader}" is not found.`,
            }),
            404,
          );
        }

        try {
          await route.value(req, res);
        } catch (error) {
          return writeErrorResponse(
            res,
            isRuntimeError(error)
              ? error
              : new SystemError({
                  subtag: "InternalServerError",
                  message: "Internal Server Error",
                  cause: error,
                }),
            HttpServerError.isHttpServerError(error)
              ? (error.response?.status ?? 500)
              : 500,
          );
        }
      }),
    );
    // workerd re-connects for every loopback subrequest once its pooled
    // connection is closed. Node's default `keepAliveTimeout` of 5s closes
    // idle sockets between test/request bursts, producing per-burst TCP churn
    // that piles up TIME_WAIT sockets — on Windows CI this exhausts ephemeral
    // ports/AFD buffers (WSAENOBUFS #10055, ConnectEx ERROR_DUP_NAME #52).
    // Keep idle connections around for a minute so they actually get reused.
    server.keepAliveTimeout = 60_000;
    // Must stay above `keepAliveTimeout` so Node doesn't tear down a reused
    // socket while request headers are still arriving.
    server.headersTimeout = 65_000;
    yield* Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    });
    const address = yield* getAddress(server);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // `close()` only stops listening; long-lived keep-alive connections
        // would otherwise linger until the peer closes them.
        server.close();
        server.closeAllConnections();
      }),
    );
    const scope = yield* Effect.scope;
    const makeHandler = yield* Effect.promise(
      async () =>
        await import("@effect/platform-node/NodeHttpServer").then(
          (m) => m.makeHandler,
        ),
    );
    return LoopbackServer.of({
      address,
      secret,
      route: (name, handler) =>
        Effect.isEffect(handler)
          ? makeHandler(handler, { scope }).pipe(
              Effect.map((handler) => {
                MutableHashMap.set(routes, name, handler);
                return Effect.void;
              }),
            )
          : Effect.sync(() => {
              MutableHashMap.set(routes, name, handler);
              return Effect.void;
            }),
    });
  }),
);

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const writeErrorResponse = (
  res: NodeHttp.ServerResponse,
  error: RuntimeError,
  status: number = 500,
) => {
  const body = makeErrorEnvelope(error);
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(JSON.stringify(body));
};
