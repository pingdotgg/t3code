import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  makeAcpPromptBusyRetryGate,
  retryPromptOnBusy,
  type AcpPromptBusyRetryPolicy,
} from "./promptBusyRetry.ts";

class BusyError extends Error {
  override readonly name = "BusyError";
  readonly _tag = "BusyError";
}

class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly _tag = "ProviderError";
}

const busyPolicy: AcpPromptBusyRetryPolicy = {
  maxAttempts: 3,
  isBusyFailure: (cause) =>
    Cause.findErrorOption(cause).pipe((option) =>
      option._tag === "Some" ? option.value instanceof BusyError : false,
    ),
  delayMs: () => 1_000,
};

describe("retryPromptOnBusy", () => {
  it.effect("re-sends a prompt the agent rejected as busy and keeps the successful result", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new BusyError("session is busy"))
              : Effect.succeed("accepted");
          }),
        ),
      );
      yield* TestClock.adjust(1_000);

      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result, "accepted");
      assert.strictEqual(attempts, 2);
    }),
  );

  it.effect("waits before re-sending so the agent can release its turn lease", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new BusyError("session is busy"))
              : Effect.succeed("accepted");
          }),
        ),
      );

      yield* TestClock.adjust(999);
      assert.strictEqual(attempts, 1);

      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      assert.strictEqual(attempts, 2);
    }),
  );

  it.effect("stops retrying once the attempt budget is spent", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new BusyError("session is busy"));
          }),
        ),
      );
      yield* TestClock.adjust(10_000);

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(attempts, 3);
    }),
  );

  it.effect("does not retry a failure that is not a busy rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const exit = yield* Effect.exit(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new ProviderError());
          }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(attempts, 1);
    }),
  );

  it.effect("does not retry an interrupt", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const exit = yield* Effect.exit(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return Effect.interrupt;
          }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(attempts, 1);
    }),
  );

  it.effect("runs the prompt once when no policy is configured", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const exit = yield* Effect.exit(
        retryPromptOnBusy(
          undefined,
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new BusyError("session is busy"));
          }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(attempts, 1);
    }),
  );

  it.effect("does not re-send a prompt that was cancelled while it was waiting", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new BusyError("session is busy"));
          }),
          { cancelled: Effect.succeed(true) },
        ),
      );
      yield* TestClock.adjust(1_000);

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(attempts, 1);
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }
    }),
  );

  it.effect("re-sends a prompt that is still allowed to be delivered", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new BusyError("session is busy"))
              : Effect.succeed("accepted");
          }),
          { cancelled: Effect.succeed(false) },
        ),
      );
      yield* TestClock.adjust(1_000);

      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result, "accepted");
      assert.strictEqual(attempts, 2);
    }),
  );
});

describe("AcpPromptBusyRetryGate", () => {
  it.effect("drops a prompt that was issued before the cancel", () =>
    Effect.gen(function* () {
      const gate = yield* makeAcpPromptBusyRetryGate();
      yield* gate.issue;
      assert.isFalse(yield* gate.cancelled);

      yield* gate.cancel;
      assert.isTrue(yield* gate.cancelled);
    }),
  );

  it.effect("keeps a prompt that is issued after the cancel", () =>
    Effect.gen(function* () {
      const gate = yield* makeAcpPromptBusyRetryGate();
      yield* gate.cancel;

      yield* gate.issue;
      assert.isFalse(yield* gate.cancelled);
    }),
  );

  it.effect("does not re-send a prompt that was cancelled while it was waiting", () =>
    Effect.gen(function* () {
      const gate = yield* makeAcpPromptBusyRetryGate();
      yield* gate.issue;
      let attempts = 0;
      const fiber = yield* Effect.forkChild(
        retryPromptOnBusy(
          busyPolicy,
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new BusyError("session is busy"));
          }),
          { cancelled: gate.cancelled },
        ),
      );

      // The user stops the turn while the prompt waits to be re-sent.
      yield* gate.cancel;
      yield* TestClock.adjust(10_000);

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(attempts, 1);
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }
    }),
  );
});
