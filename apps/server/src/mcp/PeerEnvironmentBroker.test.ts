import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PeerEnvironmentOperation,
  type PeerEnvironmentResponse,
  type PeerEnvironmentSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PeerEnvironmentBroker from "./PeerEnvironmentBroker.ts";

const makeBroker = PeerEnvironmentBroker.make.pipe(Effect.provide(NodeServices.layer));
const r2d2 = EnvironmentId.make("environment-r2d2");
const summary = (status: PeerEnvironmentSummary["status"]): PeerEnvironmentSummary => ({
  environmentId: r2d2,
  label: "r2d2",
  status,
});

/** A connected app that answers every request with `answer`. */
const connectApp = (
  broker: PeerEnvironmentBroker.PeerEnvironmentBroker["Service"],
  clientId: string,
  answer: (operation: PeerEnvironmentOperation) => PeerEnvironmentResponse["outcome"] | null,
) =>
  Effect.gen(function* () {
    const events = yield* broker.connect({ clientId });
    const connected = yield* Deferred.make<void>();
    yield* events.pipe(
      Stream.runForEach((event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        const outcome = answer(event.request.operation);
        return outcome === null
          ? Effect.void
          : broker.respond({
              clientId,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              outcome,
            });
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(connected);
  });

it.effect("refuses to reach another environment when no app is connected", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    const error = yield* Effect.flip(broker.invoke({ operation: "catalog", environmentId: r2d2 }));
    assert.equal(error.code, "host_unavailable");
    assert.include(error.message, "connected to both");
  }),
);

it.effect("carries a request through the connected app and returns its answer", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    const seen: Array<PeerEnvironmentOperation> = [];
    yield* connectApp(broker, "desktop", (operation) => {
      seen.push(operation);
      return { ok: true, result: { operation: "list", environments: [summary("connected")] } };
    });
    assert.deepEqual(yield* broker.list, [summary("connected")]);
    assert.deepEqual(seen, [{ operation: "list" }]);
  }).pipe(Effect.scoped),
);

it.effect("tries another app when the newest one cannot reach the target", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    yield* connectApp(broker, "desktop", () => ({
      ok: true,
      result: {
        operation: "catalog",
        label: "r2d2",
        serverVersion: "1.0.0",
        providers: [],
        projects: [],
      },
    }));
    yield* connectApp(broker, "phone", () => ({
      ok: false,
      code: "environment_not_connected",
      message: "not saved on this phone",
    }));
    const result = yield* broker.invoke({ operation: "catalog", environmentId: r2d2 });
    assert.equal(result.label, "r2d2");
  }).pipe(Effect.scoped),
);

it.effect("does not retry elsewhere once the target itself refused the request", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    let olderAppAsked = false;
    yield* connectApp(broker, "desktop", () => {
      olderAppAsked = true;
      return null;
    });
    yield* connectApp(broker, "phone", () => ({
      ok: false,
      code: "environment_unauthorized",
      message: "r2d2 refused the request",
    }));
    const error = yield* Effect.flip(broker.invoke({ operation: "catalog", environmentId: r2d2 }));
    assert.equal(error.code, "environment_unauthorized");
    assert.isFalse(olderAppAsked);
  }).pipe(Effect.scoped),
);

it.effect("ignores an answer that does not come from the app that was asked", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    const events = yield* broker.connect({ clientId: "desktop" });
    const fiber = yield* broker
      .invoke({ operation: "catalog", environmentId: r2d2 }, 1_000)
      .pipe(Effect.flip, Effect.forkScoped);
    const request = yield* events.pipe(
      Stream.filter((event) => event.type === "request"),
      Stream.runHead,
    );
    assert.isTrue(request._tag === "Some");
    if (request._tag !== "Some") return;
    yield* broker.respond({
      clientId: "someone-else",
      connectionId: request.value.connectionId,
      requestId: request.value.request.requestId,
      outcome: { ok: true, result: { operation: "list", environments: [] } },
    });
    yield* TestClock.adjust(3_000);
    const error = yield* Fiber.join(fiber);
    assert.equal(error.code, "host_unavailable");
  }).pipe(Effect.scoped),
);

it.effect("reports the best status when several apps know the same environment", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    yield* connectApp(broker, "desktop", () => ({
      ok: true,
      result: { operation: "list", environments: [summary("connected")] },
    }));
    yield* connectApp(broker, "phone", () => ({
      ok: true,
      result: { operation: "list", environments: [summary("offline")] },
    }));
    assert.deepEqual(yield* broker.list, [summary("connected")]);
  }).pipe(Effect.scoped),
);
