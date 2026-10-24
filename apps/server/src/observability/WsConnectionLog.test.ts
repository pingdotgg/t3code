import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as WsConnectionLog from "./WsConnectionLog.ts";

const connectedAtMs = Date.UTC(2026, 9, 23, 12, 21, 0);

describe("WsConnectionLog", () => {
  it("tells a dropped connection from a close frame, invalidation and shutdown", () => {
    const describeClose = (
      observation: Partial<WsConnectionLog.WsConnectionObservation>,
      exit: Exit.Exit<unknown, unknown> = Exit.void,
    ) =>
      WsConnectionLog.wsCloseAttributes({
        observation: { ...WsConnectionLog.makeObservation(), ...observation },
        exit,
        connectedAtMs,
        closedAtMs: connectedAtMs + 60_000,
      });

    assert.deepStrictEqual(
      describeClose({ closeCode: 1006, lastInboundAtMs: connectedAtMs + 44_000 }),
      {
        endedBy: "connection_lost",
        closeCode: 1006,
        durationMs: 60_000,
        lastInboundAgeMs: 16_000,
      },
    );
    assert.strictEqual(describeClose({ closeCode: 1000 }).endedBy, "close_frame");
    // Invalidation interrupts the socket, so no close code reaches the reader.
    assert.strictEqual(describeClose({ invalidated: true }).endedBy, "session_invalidated");
    assert.strictEqual(describeClose({}, Exit.interrupt()).endedBy, "server_interrupted");
    assert.strictEqual(describeClose({}, Exit.die("boom")).endedBy, "server_error");
  });

  it.effect("records the last successful read and the close code from the upgraded socket", () =>
    Effect.gen(function* () {
      let pulls = 0;
      const socket = Socket.make({
        reader: Effect.succeed({
          pull: Effect.suspend(() =>
            pulls++ === 0
              ? Effect.succeed(["ping"] as const)
              : Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketCloseError({ code: 1006 }),
                  }),
                ),
          ),
          upgrade: () => Effect.void,
        }),
        writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
      });
      const request = Object.create(HttpServerRequest.fromWeb(new Request("http://localhost/ws")), {
        upgrade: { value: Effect.succeed(socket) },
      }) as HttpServerRequest.HttpServerRequest;
      const observation = WsConnectionLog.makeObservation();

      yield* TestClock.setTime(connectedAtMs);
      const reader = yield* (yield* WsConnectionLog.observeUpgrade(request, observation).upgrade)
        .reader;
      yield* TestClock.adjust("10 seconds");
      yield* reader.pull;
      yield* TestClock.adjust("25 seconds");
      yield* Effect.flip(reader.pull);

      assert.deepStrictEqual(
        WsConnectionLog.wsCloseAttributes({
          observation,
          exit: Exit.void,
          connectedAtMs,
          closedAtMs: yield* Clock.currentTimeMillis,
        }),
        {
          endedBy: "connection_lost",
          closeCode: 1006,
          durationMs: 35_000,
          lastInboundAgeMs: 25_000,
        },
      );
    }).pipe(Effect.scoped),
  );
});
