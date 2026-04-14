import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_THREAD_DETAIL_ATOM,
  EMPTY_THREAD_DETAIL_STATE,
  createThreadDetailManager,
  getThreadDetailTargetKey,
  threadDetailStateAtom,
  type ThreadDetailState,
  type ThreadDetailTarget,
} from "@t3tools/client-runtime";
import { useEffect, useMemo } from "react";

import { derivePendingApprovals, derivePendingUserInputs } from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./use-remote-environment-registry";
import { useThreadSelection } from "./use-thread-selection";

function shouldKeepThreadDetailWarm(state: ThreadDetailState): boolean {
  const thread = state.data;
  if (!thread || state.isDeleted) {
    return false;
  }

  if (thread.latestTurn?.sourceProposedPlan) {
    return true;
  }

  const sessionStatus = thread.session?.status;
  if (sessionStatus && sessionStatus !== "idle" && sessionStatus !== "stopped") {
    return true;
  }

  return (
    derivePendingApprovals(thread.activities).length > 0 ||
    derivePendingUserInputs(thread.activities).length > 0
  );
}

export const threadDetailManager = createThreadDetailManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.orchestration : null;
  },
  getClientIdentity: (environmentId) => {
    return getEnvironmentClient(environmentId) ? environmentId : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
  retention: {
    idleTtlMs: 5 * 60 * 1_000,
    maxRetainedEntries: 24,
    shouldKeepWarm: (_target, state) => shouldKeepThreadDetailWarm(state),
  },
});

export function useThreadDetail(target: ThreadDetailTarget): ThreadDetailState {
  const { environmentId, threadId } = target;
  const targetKey = getThreadDetailTargetKey(target);

  useEffect(
    () => threadDetailManager.watch({ environmentId, threadId }),
    [environmentId, threadId],
  );

  const state = useAtomValue(
    targetKey !== null ? threadDetailStateAtom(targetKey) : EMPTY_THREAD_DETAIL_ATOM,
  );
  return targetKey === null ? EMPTY_THREAD_DETAIL_STATE : state;
}

export function useSelectedThreadDetail() {
  const { selectedThread } = useThreadSelection();
  const state = useThreadDetail({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });

  return useMemo(() => state.data, [state.data]);
}
