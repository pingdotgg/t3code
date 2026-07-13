import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const isRequestTimeoutError = Schema.is(CodexError.CodexAppServerRequestTimeoutError);
const encoder = new TextEncoder();
const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

it.layer(NodeServices.layer)("effect-codex-app-server protocol request timeouts", (it) => {
  it.effect("control-plane requests fail with RequestTimeout after the default 60s", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const fiber = yield* transport
        .request("initialize", { clientInfo: { name: "t" } })
        .pipe(
          Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }),
          Effect.forkScoped,
        );

      yield* TestClock.adjust(Duration.seconds(60));
      const error = yield* Fiber.join(fiber);
      assert.isTrue(isRequestTimeoutError(error));
      if (isRequestTimeoutError(error)) {
        assert.equal(error.method, "initialize");
        assert.equal(error.timeoutMs, 60_000);
      }
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("timeout: none does not fire at 60s and still accepts a late response", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const fiber = yield* transport
        .request("turn/start", { threadId: "t1" }, { timeout: "none" })
        .pipe(Effect.forkScoped);

      yield* TestClock.adjust(Duration.seconds(90));

      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          result: { turn: { id: "turn-1" } },
        }),
      );

      const result = yield* Fiber.join(fiber);
      assert.deepEqual(result, { turn: { id: "turn-1" } });
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("thread resume and read have no default timeout", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const resumeFiber = yield* transport
        .request("thread/resume", { threadId: "t1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      const readFiber = yield* transport
        .request("thread/read", { threadId: "t1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* TestClock.adjust(Duration.seconds(90));
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: { thread: { id: "t1" } } }));
      yield* Queue.offer(input, encodeJsonl({ id: 2, result: { thread: { id: "t1" } } }));

      assert.deepEqual(yield* Fiber.join(resumeFiber), { thread: { id: "t1" } });
      assert.deepEqual(yield* Fiber.join(readFiber), { thread: { id: "t1" } });
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("explicit short timeout fires for control-plane requests", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const fiber = yield* transport
        .request("thread/read", { threadId: "t" }, { timeout: Duration.seconds(5) })
        .pipe(
          Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }),
          Effect.forkScoped,
        );

      yield* TestClock.adjust(Duration.seconds(5));
      const error = yield* Fiber.join(fiber);
      assert.isTrue(isRequestTimeoutError(error));
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );
});
