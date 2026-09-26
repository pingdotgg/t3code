// This boundary owns the raw listener so handlers can attach before TCP accepts requests.
// HttpServer.make erases the app error type; the Effect handler builders handle those errors.
// @effect-diagnostics nodeBuiltinImport:off anyUnknownInErrorContext:off
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/unstable/http";
import { ServeError } from "effect/unstable/http/HttpServerError";
import * as NetAddress from "effect/unstable/net/NetAddress";

import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";

export class HttpListener extends Context.Service<
  HttpListener,
  { readonly start: Effect.Effect<void, ServeError> }
>()("t3/deferredHttpServer/HttpListener") {}

/** Builds the HTTP service without accepting connections; start waits for serve's handlers. */
export const layer = (options: {
  readonly host: string;
  readonly port: number;
  readonly websocket?: NodeHttpServer.Options["websocket"];
}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const resolved = yield* Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(options.host),
        catch: (cause) => new ServeError({ cause }),
      });
      let address = yield* Effect.fromResult(
        NetAddress.inetAddressFromIpString(resolved.address, options.port),
      ).pipe(Effect.mapError((cause) => new ServeError({ cause })));
      const attached = yield* Deferred.make<void>();
      const server = guardHttpResponseWriteErrors(NodeHttp.createServer());
      const sockets = new Set<NodeNet.Socket>();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      const wss = new NodeWS.WebSocketServer({ ...options.websocket, noServer: true });
      let closed = false;
      let serving = false;
      // T3 uses immediate HTTP shutdown. Include upgraded sockets, which closeAllConnections skips.
      const close = yield* Effect.callback<void>((resume) => {
        closed = true;
        for (const client of wss.clients) client.terminate();
        for (const socket of sockets) socket.destroy();
        wss.close();
        if (!server.listening) {
          resume(Effect.void);
          return;
        }
        server.close((error) => resume(error ? Effect.die(error) : Effect.void));
      }).pipe(Effect.cached);
      yield* Effect.addFinalizer(() => close);

      const startLock = yield* Semaphore.make(1);
      let started = false;
      const start = Deferred.await(attached)
        .pipe(
          Effect.andThen(
            Effect.callback<void, ServeError>((resume) => {
              if (closed) {
                resume(Effect.fail(new ServeError({ cause: new Error("HTTP server is closed") })));
                return;
              }
              if (started) {
                resume(Effect.void);
                return;
              }
              const controller = new AbortController();
              const onError = (cause: Error) => {
                server.off("listening", onListening);
                resume(Effect.fail(new ServeError({ cause })));
              };
              const onListening = () => {
                server.off("error", onError);
                const bound = server.address();
                if (bound === null || typeof bound === "string") {
                  resume(
                    Effect.fail(new ServeError({ cause: new Error("Expected a TCP address") })),
                  );
                  return;
                }
                resume(
                  Effect.fromResult(
                    NetAddress.inetAddressFromIpString(bound.address, bound.port),
                  ).pipe(
                    Effect.mapError((cause) => new ServeError({ cause })),
                    Effect.tap((value) =>
                      Effect.sync(() => {
                        address = value;
                        started = true;
                      }),
                    ),
                    Effect.asVoid,
                  ),
                );
              };
              server.once("error", onError);
              server.once("listening", onListening);
              server.listen({
                host: resolved.address,
                port: options.port,
                signal: controller.signal,
              });
              return Effect.sync(() => {
                server.off("error", onError);
                server.off("listening", onListening);
                controller.abort();
              });
            }),
          ),
        )
        .pipe(startLock.withPermit);

      const service = HttpServer.make({
        // Before start, consumers may read the configured address. After start, expose the bound port.
        get address() {
          return address;
        },
        serve: Effect.fn("DeferredHttpServer.serve")(function* (app, middleware) {
          if (serving || closed)
            return yield* Effect.die(new Error("HTTP server already served or closed"));
          serving = true;
          const scope = yield* Effect.scope;
          const requestScope = Scope.forkUnsafe(scope, "parallel");
          const request = yield* NodeHttpServer.makeHandler(app, {
            scope: requestScope,
            middleware,
          });
          const upgrade = yield* NodeHttpServer.makeUpgradeHandler(Effect.succeed(wss), app, {
            scope: requestScope,
            middleware,
          });
          yield* Effect.addFinalizer(() =>
            close.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  server.off("request", request);
                  server.off("upgrade", upgrade);
                }),
              ),
            ),
          );
          server.on("request", request);
          server.on("upgrade", upgrade);
          yield* Deferred.succeed(attached, undefined);
        }),
      });
      return Context.make(HttpServer.HttpServer, service).pipe(
        Context.add(HttpListener, { start }),
      );
    }),
  ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices));
