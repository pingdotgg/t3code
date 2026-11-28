import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import {
  SOCKET_HEARTBEAT_FRAME,
  SOCKET_HEARTBEAT_INTERVAL,
  withSocketHeartbeat,
} from "./socketHeartbeat.ts";

describe("withSocketHeartbeat", () => {
  it.effect("writes a heartbeat each interval until the writer's scope closes", () =>
    Effect.gen(function* () {
      const written: Array<string | Uint8Array | Socket.CloseEvent> = [];
      const socket = withSocketHeartbeat(
        Socket.make({
          reader: Effect.never,
          writer: Effect.succeed({
            write: (chunk) => Effect.sync(() => void written.push(chunk)),
            writeAll: (chunks) => Effect.sync(() => void written.push(...chunks)),
          }),
        }),
      );
      const scope = yield* Scope.make();
      yield* Scope.provide(socket.writer, scope);

      yield* TestClock.adjust(SOCKET_HEARTBEAT_INTERVAL);
      yield* TestClock.adjust(SOCKET_HEARTBEAT_INTERVAL);
      assert.deepStrictEqual(written, [SOCKET_HEARTBEAT_FRAME, SOCKET_HEARTBEAT_FRAME]);

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(SOCKET_HEARTBEAT_INTERVAL);
      assert.strictEqual(written.length, 2);
    }),
  );
});
