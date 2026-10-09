// @effect-diagnostics globalTimers:off -- the flush helper uses a macrotask so runPromise chains settle before assertions.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { makeCloseGuardHandler } from "./CloseGuard.ts";

const flushAsyncWork = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function makeOptions(overrides?: {
  readonly platform?: NodeJS.Platform;
  readonly shouldGuard?: () => boolean;
  readonly hasRunningActivity?: () => Promise<number>;
  readonly confirmClose?: (runningCount: number) => Promise<boolean>;
  readonly close?: () => void;
}) {
  return {
    platform: overrides?.platform ?? "linux",
    shouldGuard: overrides?.shouldGuard ?? (() => true),
    hasRunningActivity: overrides?.hasRunningActivity ?? (async () => 0),
    confirmClose:
      overrides?.confirmClose ??
      (async () => {
        throw new Error("unexpected confirmClose");
      }),
    close: overrides?.close ?? vi.fn(),
  };
}

describe("makeCloseGuardHandler", () => {
  it.effect("passes the close through when the guard is disarmed", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const handler = makeCloseGuardHandler(makeOptions({ shouldGuard: () => false, close }));
      const event = { preventDefault: vi.fn() };

      handler(event);
      yield* flushAsyncWork;

      assert.equal(event.preventDefault.mock.calls.length, 0);
      assert.equal(close.mock.calls.length, 0);
    }),
  );

  it.effect("passes the close through on macOS where closing does not quit", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const handler = makeCloseGuardHandler(makeOptions({ platform: "darwin", close }));
      const event = { preventDefault: vi.fn() };

      handler(event);
      yield* flushAsyncWork;

      assert.equal(event.preventDefault.mock.calls.length, 0);
      assert.equal(close.mock.calls.length, 0);
    }),
  );

  it.effect("closes immediately when nothing is running", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const handler = makeCloseGuardHandler(makeOptions({ close }));
      const event = { preventDefault: vi.fn() };

      handler(event);
      yield* flushAsyncWork;

      assert.equal(event.preventDefault.mock.calls.length, 1);
      assert.equal(close.mock.calls.length, 1);
    }),
  );

  it.effect("closes when the user confirms the running-activity dialog", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const confirmClose = vi.fn(async () => true);
      const handler = makeCloseGuardHandler(
        makeOptions({ hasRunningActivity: async () => 3, confirmClose, close }),
      );
      const event = { preventDefault: vi.fn() };

      handler(event);
      yield* flushAsyncWork;

      assert.deepEqual(confirmClose.mock.calls, [[3]]);
      assert.equal(close.mock.calls.length, 1);
    }),
  );

  it.effect("keeps the window open when the user cancels", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const handler = makeCloseGuardHandler(
        makeOptions({ hasRunningActivity: async () => 1, confirmClose: async () => false, close }),
      );
      const event = { preventDefault: vi.fn() };

      handler(event);
      yield* flushAsyncWork;

      assert.equal(event.preventDefault.mock.calls.length, 1);
      assert.equal(close.mock.calls.length, 0);
    }),
  );

  it.effect("fails open when the probe rejects", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      const handler = makeCloseGuardHandler(
        makeOptions({ hasRunningActivity: () => Promise.reject(new Error("down")), close }),
      );
      const event = { preventDefault: vi.fn() };

      handler(event);
      yield* flushAsyncWork;

      assert.equal(close.mock.calls.length, 1);
    }),
  );

  it.effect("keeps guarding a second close request while a decision is pending", () =>
    Effect.gen(function* () {
      const close = vi.fn();
      let resolveDialog: ((value: boolean) => void) | undefined;
      const dialogGate = new Promise<boolean>((resolve) => {
        resolveDialog = resolve;
      });
      let probeCalls = 0;
      const handler = makeCloseGuardHandler(
        makeOptions({
          hasRunningActivity: () => {
            probeCalls += 1;
            return Promise.resolve(1);
          },
          confirmClose: () => dialogGate,
          close,
        }),
      );

      const firstEvent = { preventDefault: vi.fn() };
      handler(firstEvent);
      const secondEvent = { preventDefault: vi.fn() };
      handler(secondEvent);

      assert.equal(firstEvent.preventDefault.mock.calls.length, 1);
      assert.equal(secondEvent.preventDefault.mock.calls.length, 1);
      assert.equal(probeCalls, 1);
      assert.equal(close.mock.calls.length, 0);

      resolveDialog?.(true);
      yield* flushAsyncWork;
      assert.equal(close.mock.calls.length, 1);
    }),
  );
});
