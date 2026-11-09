import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { RpcServer } from "effect/rpc";
import * as TestClock from "effect/testing/TestClock";

import * as WsClientLiveness from "./wsClientLiveness.ts";

type Receive = Parameters<RpcServer.Protocol["Service"]["run"]>[0];

const observedClient = (
  readProgress: () => WsClientLiveness.TransportProgress = () => ({
    pendingBytes: 0,
    bytesWritten: 0,
    bytesRead: 0,
  }),
) =>
  Effect.gen(function* () {
    const liveness = yield* WsClientLiveness.make(readProgress);
    let receive: Receive | undefined;
    const protocol = liveness.observe({
      run: (write: Receive) => {
        receive = write;
        return Effect.never;
      },
    } as unknown as RpcServer.Protocol["Service"]);
    yield* protocol.run(() => Effect.void).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const ping = Effect.suspend(() => receive?.(0, { _tag: "Ping" }) ?? Effect.void);
    const unresponsive = yield* liveness.awaitUnresponsive.pipe(Effect.forkChild);
    return { ping, unresponsive };
  });

it.effect("treats a client that stops sending as gone after the silence limit", () =>
  Effect.gen(function* () {
    const { ping, unresponsive } = yield* observedClient();

    yield* TestClock.adjust("60 seconds");
    yield* ping;
    yield* TestClock.adjust("85 seconds");
    assert.isUndefined(unresponsive.pollUnsafe());

    yield* TestClock.adjust("5 seconds");
    assert.deepStrictEqual(yield* Fiber.join(unresponsive), {
      reason: "client-silent",
      silentForMs: 90_000,
      bytesReadWhileSilent: 0,
      pendingBytes: 0,
    });
  }),
);

it.effect("reports bytes that arrived while no message was handled", () =>
  Effect.gen(function* () {
    const progress = { pendingBytes: 0, bytesWritten: 0, bytesRead: 100 };
    const { ping, unresponsive } = yield* observedClient(() => progress);

    yield* ping;
    progress.bytesRead += 4_096;
    yield* TestClock.adjust("90 seconds");
    assert.deepStrictEqual(yield* Fiber.join(unresponsive), {
      reason: "client-silent",
      silentForMs: 90_000,
      bytesReadWhileSilent: 4_096,
      pendingBytes: 0,
    });
  }),
);

it.effect("keeps a pinging client connected", () =>
  Effect.gen(function* () {
    const { ping, unresponsive } = yield* observedClient();

    for (let second = 0; second < 600; second += 5) {
      yield* TestClock.adjust("5 seconds");
      yield* ping;
    }
    assert.isUndefined(unresponsive.pollUnsafe());
  }),
);

it.effect("treats a send backlog that stops draining as a stalled client", () =>
  Effect.gen(function* () {
    const progress = { pendingBytes: 0, bytesWritten: 0, bytesRead: 0 };
    const { ping, unresponsive } = yield* observedClient(() => progress);

    // A slow reader still drains the queue, however little at a time.
    for (let second = 0; second < 60; second += 5) {
      progress.pendingBytes = 2_000_000;
      progress.bytesWritten += 1_000;
      yield* TestClock.adjust("5 seconds");
      yield* ping;
    }
    assert.isUndefined(unresponsive.pollUnsafe());

    // Its pings still arrive, but nothing it is sent leaves the queue.
    for (let second = 0; second < 25; second += 5) {
      yield* TestClock.adjust("5 seconds");
      yield* ping;
    }
    assert.isUndefined(unresponsive.pollUnsafe());
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual((yield* Fiber.join(unresponsive)).reason, "send-stalled");
  }),
);
