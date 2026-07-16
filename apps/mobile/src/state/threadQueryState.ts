import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import { causeFailureMessage } from "@t3tools/client-runtime/errors";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

function formatThreadStateFailure(cause: Cause.Cause<unknown>): string {
  return causeFailureMessage(cause, "Could not load conversation.");
}

export function environmentThreadStateFromAsyncResult(
  result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>,
): EnvironmentThreadState {
  const value = Option.getOrNull(AsyncResult.value(result));
  if (AsyncResult.isFailure(result)) {
    return {
      ...(value ?? EMPTY_ENVIRONMENT_THREAD_STATE),
      error: Option.some(formatThreadStateFailure(result.cause)),
    };
  }

  return value ?? EMPTY_ENVIRONMENT_THREAD_STATE;
}
