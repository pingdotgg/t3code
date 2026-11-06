import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Errors here are thread/history-local and must not be promoted into the environment
   * disconnect path.
   */
  readonly history: ThreadHistoryMeta;
  /** The last server sequence `data` reflects, so readers can tell a write has landed without searching paged-out history. */
  readonly sequence: number;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
  sequence: 0,
};

/**
 * A thread holds a write once it has applied the write's commit sequence. A bounded
 * projection can page the message out later, so finding it is only a fallback for
 * servers that do not report the sequence.
 */
export function threadHasCaughtUpTo(
  write: { readonly messageId: string; readonly sequence?: number | undefined },
  thread: {
    readonly sequence: number;
    readonly messages: ReadonlyArray<{ readonly id: string }> | undefined;
  },
): boolean {
  if (write.sequence !== undefined && thread.sequence >= write.sequence) return true;
  return thread.messages?.some((entry) => entry.id === write.messageId) ?? false;
}
