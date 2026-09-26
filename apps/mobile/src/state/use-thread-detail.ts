import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { useEnvironmentThread } from "./threads";
import { useThreadSelection } from "./use-thread-selection";

export interface ThreadDetailTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

export function useThreadDetail(target: ThreadDetailTarget) {
  return useEnvironmentThread(target.environmentId, target.threadId);
}

/**
 * The selection owns the subscription so it can hold it back while a queued
 * creation has not reached the server yet.
 */
export function useSelectedThreadDetailState() {
  return useThreadSelection().selectedThreadDetailState;
}

export function useSelectedThreadDetail() {
  return Option.getOrNull(useSelectedThreadDetailState().data);
}
