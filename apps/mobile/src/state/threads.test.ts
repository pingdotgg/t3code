import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { environmentThreadStateFromAsyncResult } from "./threadQueryState";

describe("environmentThreadStateFromAsyncResult", () => {
  it("returns the empty state while the first value is loading", () => {
    expect(environmentThreadStateFromAsyncResult(AsyncResult.initial(true))).toEqual(
      EMPTY_ENVIRONMENT_THREAD_STATE,
    );
  });

  it("surfaces a failure when no previous value exists", () => {
    const state = environmentThreadStateFromAsyncResult(
      AsyncResult.failure(Cause.fail("thread sync failed")),
    );

    expect(Option.getOrNull(state.data)).toBeNull();
    expect(Option.getOrNull(state.error)).toBe("thread sync failed");
  });

  it("preserves previous thread data while surfacing a refresh failure", () => {
    const previousState = {
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      status: "live" as const,
    };
    const previousSuccess = AsyncResult.success(previousState);
    const state = environmentThreadStateFromAsyncResult(
      AsyncResult.failure(Cause.fail(new Error("refresh failed")), {
        previousSuccess: Option.some(previousSuccess),
      }),
    );

    expect(state.status).toBe("live");
    expect(Option.getOrNull(state.error)).toBe("refresh failed");
  });
});
