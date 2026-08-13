import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ThreadHistoryController,
  threadHistoryControllerLayer,
  type ThreadHistoryHandler,
  type ThreadHistoryLoadEarlierResult,
} from "./threadHistoryController.ts";

const ENV = "env-history" as EnvironmentId;
const THREAD = "thread-history" as ThreadId;

function handler(
  tag: string,
): ThreadHistoryHandler & { readonly tag: string; readonly calls: number } {
  const state = { tag, calls: 0 };
  return {
    get tag() {
      return state.tag;
    },
    get calls() {
      return state.calls;
    },
    loadEarlier: () => {
      state.calls += 1;
      return Effect.succeed({ _tag: "loaded" } satisfies ThreadHistoryLoadEarlierResult);
    },
  };
}

describe("ThreadHistoryController", () => {
  it.effect("does not let an older finalizer delete a newer registration", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController;
      const older = handler("older");
      const newer = handler("newer");

      const olderRegistration = yield* controller.register(ENV, THREAD, older);
      const newerRegistration = yield* controller.register(ENV, THREAD, newer);

      // Older fiber finalizes after the newer handler is already registered.
      yield* controller.unregister(olderRegistration);

      const result = yield* controller.loadEarlier(ENV, THREAD);
      expect(result).toEqual({ _tag: "loaded" });
      expect(newer.calls).toBe(1);
      expect(older.calls).toBe(0);

      yield* controller.unregister(newerRegistration);
      expect(yield* controller.loadEarlier(ENV, THREAD)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(threadHistoryControllerLayer)),
  );

  it.effect("unregister removes only its own matching registration", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController;
      const first = handler("first");
      const registration = yield* controller.register(ENV, THREAD, first);
      yield* controller.unregister(registration);
      expect(yield* controller.loadEarlier(ENV, THREAD)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(Layer.fresh(threadHistoryControllerLayer))),
  );
});
