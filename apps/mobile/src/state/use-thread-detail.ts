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

export function useSelectedThreadDetailState() {
  const { selectedThread } = useThreadSelection();
  return useThreadDetail({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}

export function useSelectedThreadDetail() {
  return Option.getOrNull(useSelectedThreadDetailState().data);
}
