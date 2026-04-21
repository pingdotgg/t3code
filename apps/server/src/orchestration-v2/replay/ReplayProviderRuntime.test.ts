import { ProviderReplayTranscript } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Schema } from "effect";
import { TestClock } from "effect/testing";

import { makeReplayProviderRuntime } from "./ReplayProviderRuntime.ts";
import {
  ProviderRuntimeOutboundMismatchError,
  ProviderRuntimeTransportError,
} from "../Services/ProviderRuntimeTransport.ts";

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

const transcript = Schema.decodeUnknownSync(ProviderReplayTranscript)({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.120.0",
  scenario: "replay-runtime-smoke",
  entries: [
    {
      type: "expect_outbound",
      frame: {
        id: 1,
        method: "initialize",
        params: { capabilities: { experimentalApi: true } },
      },
    },
    {
      type: "emit_inbound",
      afterMs: 25,
      frame: {
        id: 1,
        result: { userAgent: "fixture" },
      },
    },
    {
      type: "runtime_exit",
      status: "success",
    },
  ],
});

describe("ReplayProviderRuntime", () => {
  it.effect("asserts outbound frames and replays inbound frames deterministically", () =>
    Effect.gen(function* () {
      const runtime = yield* makeReplayProviderRuntime(transcript);
      const generatedId = yield* Random.nextUUIDv4;

      yield* runtime.send({
        params: { capabilities: { experimentalApi: true } },
        method: "initialize",
        id: 1,
      });

      const inboundFiber = yield* runtime.receive().pipe(Effect.forkScoped);
      yield* TestClock.adjust("25 millis");

      const inbound = yield* Fiber.join(inboundFiber);
      assert.deepEqual(inbound, {
        type: "frame",
        frame: {
          id: 1,
          result: { userAgent: "fixture" },
        },
      });

      const exit = yield* runtime.receive();
      assert.deepEqual(exit, { type: "runtime_exit", status: "success" });
      yield* runtime.assertComplete();

      assert.equal(generatedId, "776ac12c-9b3e-4520-bf52-8954a3a6cdc8");
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
    ),
  );

  it.effect("fails on outbound mismatch instead of skipping adapter behavior", () =>
    Effect.gen(function* () {
      const runtime = yield* makeReplayProviderRuntime(transcript);
      const error = yield* runtime.send({ id: 1, method: "wrong", params: {} }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderRuntimeOutboundMismatchError);
      assert.deepEqual(Schema.encodeUnknownSync(ProviderRuntimeTransportError)(error), {
        _tag: "ProviderRuntimeOutboundMismatchError",
        scenario: "replay-runtime-smoke",
        index: 0,
        expectedFrame: {
          id: 1,
          method: "initialize",
          params: { capabilities: { experimentalApi: true } },
        },
        actualFrame: { id: 1, method: "wrong", params: {} },
      });
    }),
  );
});
