import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup, RpcTest } from "effect/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerReadiness from "./serverReadiness.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it.effect.each([
  ["GET", "/.well-known/t3/environment"],
  ["POST", "/oauth/token"],
  ["POST", "/api/auth/websocket-ticket/rpc"],
  ["GET", "/ws"],
] as const)("serves %s %s while recovery holds commands", ([method, url]) =>
  Effect.gen(function* () {
    const waitedForCommands = yield* Deferred.make<void>();
    const handler = yield* HttpRouter.toHttpEffect(
      HttpRouter.add(method, url, HttpServerResponse.empty()).pipe(
        Layer.provide(ServerReadiness.layerHttp),
        Layer.provide(
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            awaitConnectionReady: Effect.void,
            awaitCommandReady: Deferred.succeed(waitedForCommands, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          }),
        ),
      ),
    );
    const result = yield* Effect.raceFirst(
      handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`http://localhost${url}?orchestrationProtocolVersion=2`, { method }),
          ),
        ),
        Effect.as("answered"),
      ),
      Deferred.await(waitedForCommands).pipe(Effect.as("blocked")),
    );
    expect(result).toBe("answered");
  }).pipe(Effect.scoped),
);

it.effect.each([
  ["POST", "/api/projects/mutate"],
  ["GET", "/api/orchestration/shell"],
  ["POST", "/ws"],
] as const)("holds %s %s until recovery completes", ([method, url]) =>
  Effect.gen(function* () {
    const commands = yield* Deferred.make<void>();
    const waiting = yield* Deferred.make<void>();
    const handled = yield* Ref.make(false);
    const handler = yield* HttpRouter.toHttpEffect(
      HttpRouter.add(
        method,
        url,
        Ref.set(handled, true).pipe(Effect.as(HttpServerResponse.empty())),
      ).pipe(
        Layer.provide(ServerReadiness.layerHttp),
        Layer.provide(
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            awaitConnectionReady: Effect.void,
            awaitCommandReady: Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Deferred.await(commands)),
            ),
          }),
        ),
      ),
    );
    const request = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${url}`, { method })),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(waiting);
    expect(yield* Ref.get(handled)).toBe(false);
    yield* Deferred.succeed(commands, undefined);
    expect((yield* Fiber.join(request)).status).toBe(204);
    expect(yield* Ref.get(handled)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("answers connection RPCs while application calls and streams wait for recovery", () =>
  Effect.gen(function* () {
    const commands = yield* Deferred.make<void>();
    const waiting = yield* Deferred.make<void>();
    const handled = yield* Ref.make(0);
    const group = RpcGroup.make(
      Rpc.make(WS_METHODS.serverProbe, { success: Schema.String }),
      Rpc.make(WS_METHODS.subscribeServerConfig, { success: Schema.String, stream: true }),
      Rpc.make("application.write", { success: Schema.Number }),
      Rpc.make("application.stream", { success: Schema.Number, stream: true }),
    ).middleware(ServerReadiness.RpcCommandReadiness);
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayer({
            [WS_METHODS.serverProbe]: () => Effect.succeed("alive"),
            [WS_METHODS.subscribeServerConfig]: () => Stream.make("config"),
            "application.write": () => Ref.updateAndGet(handled, (count) => count + 1),
            "application.stream": () =>
              Stream.fromEffect(Ref.updateAndGet(handled, (count) => count + 1)),
          }),
          ServerReadiness.layerRpc.pipe(
            Layer.provide(
              Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                awaitCommandReady: Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(Deferred.await(commands)),
                ),
              }),
            ),
          ),
        ),
      ),
    );
    const write = yield* client["application.write"]().pipe(Effect.forkChild);
    const stream = yield* client["application.stream"]().pipe(Stream.runCollect, Effect.forkChild);
    yield* Deferred.await(waiting);
    expect(yield* client[WS_METHODS.serverProbe]()).toBe("alive");
    expect(yield* client[WS_METHODS.subscribeServerConfig]().pipe(Stream.runCollect)).toEqual([
      "config",
    ]);
    expect(yield* Ref.get(handled)).toBe(0);
    yield* Deferred.succeed(commands, undefined);
    yield* Fiber.join(write);
    yield* Fiber.join(stream);
    expect(yield* Ref.get(handled)).toBe(2);
  }).pipe(Effect.scoped),
);
