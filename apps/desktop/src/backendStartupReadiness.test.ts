import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  BackendStartupReadiness,
  type BackendStartupReadinessService,
  waitForBackendStartupReady,
  waitForBackendStartupReadyEffect,
} from "./backendStartupReadiness.ts";

function runWithStartupReadiness(service: BackendStartupReadinessService) {
  return waitForBackendStartupReadyEffect().pipe(
    Effect.provideService(BackendStartupReadiness, service),
  );
}

describe("waitForBackendStartupReadyEffect", () => {
  it.effect("falls back to the HTTP probe when no listening signal exists", () =>
    Effect.gen(function* () {
      let httpCalls = 0;
      let cancelCalls = 0;

      const source = yield* runWithStartupReadiness({
        listening: Option.none(),
        httpReady: Effect.sync(() => {
          httpCalls += 1;
        }),
        cancelHttpWait: Effect.sync(() => {
          cancelCalls += 1;
        }),
      });

      assert.equal(source, "http");
      assert.equal(httpCalls, 1);
      assert.equal(cancelCalls, 0);
    }),
  );

  it.effect("uses the listening signal and cancels the HTTP probe", () =>
    Effect.gen(function* () {
      let cancelCalls = 0;

      const source = yield* runWithStartupReadiness({
        listening: Option.some(Effect.void),
        httpReady: Effect.never,
        cancelHttpWait: Effect.sync(() => {
          cancelCalls += 1;
        }),
      });

      assert.equal(source, "listening");
      assert.equal(cancelCalls, 1);
    }),
  );

  it.effect("returns HTTP when the HTTP probe wins before listening", () =>
    Effect.gen(function* () {
      let cancelCalls = 0;

      const source = yield* runWithStartupReadiness({
        listening: Option.some(Effect.never),
        httpReady: Effect.void,
        cancelHttpWait: Effect.sync(() => {
          cancelCalls += 1;
        }),
      });

      assert.equal(source, "http");
      assert.equal(cancelCalls, 0);
    }),
  );

  it.effect("fails when the listening signal fails before HTTP readiness", () =>
    Effect.gen(function* () {
      const error = new Error("backend exited");
      let cancelCalls = 0;

      const result = yield* Effect.result(
        runWithStartupReadiness({
          listening: Option.some(Effect.fail(error)),
          httpReady: Effect.never,
          cancelHttpWait: Effect.sync(() => {
            cancelCalls += 1;
          }),
        }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure, error);
      }
      assert.equal(cancelCalls, 1);
    }),
  );

  it.effect("keeps the promise shim compatible with existing callers", () =>
    Effect.callback<void, unknown>((resume) => {
      let cancelCalls = 0;
      let rejectHttpWait: ((error: unknown) => void) | undefined;

      waitForBackendStartupReady({
        listeningPromise: Promise.resolve(),
        waitForHttpReady: () =>
          new Promise<void>((_resolve, reject) => {
            rejectHttpWait = reject;
          }),
        cancelHttpWait: () => {
          cancelCalls += 1;
          rejectHttpWait?.(new Error("cancelled"));
        },
      }).then(
        (source) => {
          assert.equal(source, "listening");
          assert.equal(cancelCalls, 1);
          resume(Effect.void);
        },
        (error) => resume(Effect.fail(error)),
      );
    }),
  );
});
