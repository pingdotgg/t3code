import type { CommandId, RunId, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly sequence: number;
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Progressive history cursor for bounded hydration. Absent/cleared on full
   * snapshot paths. Errors here are thread/history-local and must not be
   * promoted into the environment disconnect path.
   */
  readonly history: ThreadHistoryMeta;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  sequence: 0,
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};

/** Command replies can arrive before their subscription events. Only a projection
 * at or beyond the acquisition receipt can prove that an editor lost its hold. */
export function queuedRunEditOwnership(
  state: EnvironmentThreadState,
  edit: { readonly runId: RunId; readonly editId: CommandId; readonly sequence: number },
): "pending" | "owned" | "lost" {
  if (state.sequence < edit.sequence) return "pending";
  const run = Option.getOrNull(state.data)?.runs.find((run) => run.id === edit.runId);
  return run?.status === "queued" && run.queueEditId === edit.editId ? "owned" : "lost";
}
