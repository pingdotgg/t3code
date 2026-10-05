import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FleetHostRequest,
  type FleetInvokeInput,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as FleetBroker from "./FleetBroker.ts";

const hub = EnvironmentId.make("hub");
const studio = EnvironmentId.make("studio");
const layer = FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer));

const invoke: FleetInvokeInput = {
  actor: { environmentId: hub, threadId: ThreadId.make("home") },
  request: { op: "requests.list", input: { threadId: ThreadId.make("t") } },
};

// Keeps the desktop's stream open, as a live renderer does, and hands back the first request.
const serve = (requests: Stream.Stream<FleetHostRequest>) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<FleetHostRequest>();
    yield* Stream.runForEach(requests, (request) => Deferred.succeed(first, request)).pipe(
      Effect.forkScoped,
    );
    return first;
  });

const host = (clientId: string, connected = true) => ({
  clientId,
  environments: [{ environmentId: studio, label: "Studio", connected }],
});

it.effect("fails fast when no desktop window relays", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const error = yield* broker.invoke(studio, invoke).pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("environment_unavailable");
  }).pipe(Effect.provide(layer)),
);

it.effect("relays a call through the desktop and decodes the answer", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const firstRequest = yield* serve(yield* broker.connect(host("desktop")));
    yield* Effect.yieldNow;
    const call = yield* broker.invoke(studio, invoke).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(firstRequest);
    expect(request).toMatchObject({ environmentId: studio, invoke });
    yield* broker.respond({ requestId: request.requestId, result: { requestIds: [] } });
    expect(yield* Fiber.join(call)).toEqual({ requestIds: [] });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("refuses an environment the desktop reports offline", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    yield* serve(yield* broker.connect(host("desktop", false)));
    yield* Effect.yieldNow;
    const error = yield* broker.invoke(studio, invoke).pipe(Effect.asVoid, Effect.flip);
    expect(error.message).toContain("offline");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a newer desktop registration fails calls the old one still owed", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const firstRequest = yield* serve(yield* broker.connect(host("old")));
    yield* Effect.yieldNow;
    const call = yield* broker
      .invoke(studio, invoke)
      .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
    yield* Deferred.await(firstRequest);
    yield* serve(yield* broker.connect(host("new")));
    const error = yield* Fiber.join(call);
    expect(error.code).toBe("environment_unavailable");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
