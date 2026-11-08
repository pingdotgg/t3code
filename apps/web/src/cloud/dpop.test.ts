import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as Dpop from "./dpop";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dpop.loadOrCreateProofKey", () => {
  it.effect("fails when the new key's write commit aborts", () =>
    Effect.gen(function* () {
      const quotaError = new DOMException("Quota exceeded", "QuotaExceededError");
      const aborted = Deferred.makeUnsafe<void>();
      const readTransaction = {
        objectStore: () => ({
          get: () => {
            const request = new EventTarget();
            queueMicrotask(() => request.dispatchEvent(new Event("success")));
            return request;
          },
        }),
      };
      const writeTransaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              writeTransaction.error = quotaError;
              writeTransaction.dispatchEvent(new Event("abort"));
              Deferred.doneUnsafe(aborted, Effect.void);
            });
          },
        }),
      });
      const database = {
        close: () => {},
        transaction: (_store: string, mode: IDBTransactionMode) =>
          mode === "readwrite" ? writeTransaction : readTransaction,
      };
      vi.stubGlobal("indexedDB", {
        open: () => {
          const request = Object.assign(new EventTarget(), { result: database });
          queueMicrotask(() => request.dispatchEvent(new Event("success")));
          return request;
        },
      });

      const load = yield* Dpop.loadOrCreateProofKey().pipe(
        Effect.provide(Dpop.layer),
        Effect.flip,
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die(new Error("the key load never settled after its write aborted")),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(aborted);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(load);

      expect(error).toMatchObject({ message: "Could not write DPoP key.", cause: quotaError });
    }),
  );
});
