// Real TCP requests exercise listener ordering, bind errors, and socket cleanup.
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import * as Scope from "effect/Scope";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as DeferredHttpServer from "./deferredHttpServer.ts";

const make = Effect.fn("Test.make")(function* (port = 0, host = "127.0.0.1") {
  const context = yield* Layer.build(
    DeferredHttpServer.layer({ port, host, websocket: { perMessageDeflate: true } }),
  );
  return {
    server: Context.get(context, HttpServer.HttpServer),
    listener: Context.get(context, DeferredHttpServer.HttpListener),
  };
});
const portOf = (server: HttpServer.HttpServer["Service"]) => {
  if (!NetAddress.isInetAddress(server.address)) throw new Error("Expected TCP");
  return server.address.port;
};
const get = (port: number) =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, text: await response.text() };
  });
const app = Effect.succeed(HttpServerResponse.text("ready"));

it.live("keeps the port closed until handlers attach, including concurrent start callers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reservation = NodeNet.createServer();
      yield* Effect.promise(async () => {
        reservation.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => reservation.once("listening", () => resolve()));
      });
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      yield* Effect.promise(() => new Promise<void>((r) => reservation.close(() => r())));
      const { server, listener } = yield* make(address.port);
      const waiting = yield* Effect.all([listener.start, listener.start], {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      const refused = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const socket = NodeNet.connect(address.port, "127.0.0.1");
            socket.on("error", (error) =>
              resolve((error as NodeJS.ErrnoException).code ?? "unknown"),
            );
            socket.on("connect", () => {
              socket.destroy();
              resolve("connected");
            });
          }),
      );
      expect(refused).toBe("ECONNREFUSED");
      yield* server.serve(app);
      yield* Fiber.join(waiting);
      expect(yield* get(portOf(server))).toEqual({ status: 200, text: "ready" });
    }),
  ),
);

it.live("uses the actual ephemeral port and keeps independent server readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* make();
      const second = yield* make();
      yield* first.server.serve(app);
      yield* first.listener.start;
      expect(portOf(first.server)).toBeGreaterThan(0);
      expect(portOf(second.server)).toBe(0);
      yield* second.server.serve(Effect.succeed(HttpServerResponse.text("second")));
      yield* second.listener.start;
      expect(portOf(second.server)).not.toBe(portOf(first.server));
      expect((yield* get(portOf(second.server))).text).toBe("second");
    }),
  ),
);

it.live("reports an occupied port as ServeError and leaves the existing server working", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* make();
      yield* first.server.serve(app);
      yield* first.listener.start;
      const second = yield* make(portOf(first.server));
      yield* second.server.serve(app);
      const result = yield* Effect.result(second.listener.start);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("ServeError");
      expect((yield* get(portOf(first.server))).status).toBe(200);
    }),
  ),
);

it.live("interrupts a startup waiting for handlers without opening a port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { listener } = yield* make();
      const waiting = yield* listener.start.pipe(Effect.forkScoped);
      yield* Fiber.interrupt(waiting);
    }),
  ),
);

it.live(
  "releases active HTTP requests, upgraded sockets and the listening port on scope close",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const pending = yield* Deferred.make<void>();
      const { server, listener } = yield* make().pipe(Scope.provide(scope));
      const wsApp = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.url === "/ws") {
          const socket = yield* request.upgrade;
          yield* Socket.toStream(socket).pipe(Stream.runDrain, Effect.forkScoped);
          const writer = yield* socket.writer;
          yield* writer.write("ready");
          return yield* Effect.never;
        }
        yield* Deferred.succeed(pending, undefined);
        return yield* Effect.never;
      });
      yield* server.serve(wsApp.pipe(Effect.interruptible)).pipe(Scope.provide(scope));
      yield* listener.start;
      const port = portOf(server);
      const ws = new NodeWS.WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: true });
      const req = NodeHttp.get(`http://127.0.0.1:${port}/`);
      req.on("error", () => {});
      const reqClosed = new Promise<void>((resolve) => req.once("close", () => resolve()));
      const wsClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          req.destroy();
          ws.terminate();
        }),
      );
      const message = yield* Effect.promise(
        () =>
          new Promise<NodeWS.RawData>((resolve, reject) => {
            ws.once("message", resolve);
            ws.once("error", reject);
          }),
      );
      expect(String(message)).toBe("ready");
      expect(ws.extensions).toContain("permessage-deflate");
      yield* Deferred.await(pending);
      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => Promise.all([reqClosed, wsClosed]));
      const next = yield* make(port);
      yield* next.server.serve(app);
      yield* next.listener.start;
      expect((yield* get(port)).status).toBe(200);
    }).pipe(Effect.scoped),
);

it.live("can start after a cancelled waiter and rejects serving twice", () =>
  Effect.gen(function* () {
    const { server, listener } = yield* make();
    const waiter = yield* listener.start.pipe(Effect.forkScoped);
    yield* Fiber.interrupt(waiter);
    yield* server.serve(app);
    yield* listener.start;
    expect((yield* get(portOf(server))).text).toBe("ready");
    expect(Exit.isFailure(yield* Effect.exit(server.serve(app)))).toBe(true);
  }).pipe(Effect.scoped),
);

it.live("binds wildcard hosts without changing the reported address", () =>
  Effect.gen(function* () {
    const { server, listener } = yield* make(0, "0.0.0.0");
    yield* server.serve(app);
    yield* listener.start;
    expect(
      NetAddress.isInetAddress(server.address) && NetAddress.isUnspecified(server.address.address),
    ).toBe(true);
    expect((yield* get(portOf(server))).status).toBe(200);
  }).pipe(Effect.scoped),
);

it.live("rejects an unresolvable bind host before allocating a listener", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(make(0, "invalid host name"));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("ServeError");
  }).pipe(Effect.scoped),
);

it.live("does not reopen a served listener after its owning scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { server, listener } = yield* make().pipe(Scope.provide(scope));
    yield* server.serve(app).pipe(Scope.provide(scope));
    yield* listener.start;
    yield* Scope.close(scope, Exit.void);
    const result = yield* Effect.result(listener.start);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
