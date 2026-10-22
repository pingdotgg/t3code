import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  RunId,
  ScopedThreadRef,
  ThreadId,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { workspacePreparationRetryRunIds } from "@t3tools/client-runtime/state/turn-item-presentation";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import type { Thread } from "../../types";
import { resolveVisibleWorktreeSetup, resolveWorktreeSetupProgress } from "../ChatView.logic";
import { worktreeSetupAgentStarted } from "./MessagesTimeline.logic";

/** Runs with a workspace preparation retry in flight, across ChatView instances. */
const retryingWorkspacePreparationRunIds = new Set<RunId>();

/**
 * Progress of the worktree a send is preparing for this route: the live setup
 * snapshot, whether it holds the composer, and the actions on its card.
 */
export function useWorktreeSetup(input: {
  readonly routeThreadRef: ScopedThreadRef;
  // The draft id for a draft route, else the route's thread key. A bootstrap
  // rotates the thread id, so setup started from a draft stays keyed by it.
  readonly ownerKey: string;
  readonly activeThread:
    | { readonly id: ThreadId; readonly worktreePath: string | null }
    | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly serverProjection: ThreadStructure | null;
  readonly activityRun: Thread["latestRun"] | null;
  readonly localPreparing: boolean;
  // A send that the server queues behind the setup run is not held here.
  readonly sendQueuesBehindSetup: boolean;
  readonly followUpSent: boolean;
}) {
  const {
    routeThreadRef,
    ownerKey,
    activeThread,
    threadRef,
    serverProjection,
    activityRun,
    localPreparing,
    sendQueuesBehindSetup,
    followUpSent,
  } = input;
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, {
    reportFailure: false,
  });
  const retryWorkspacePreparation = useAtomCommand(threadEnvironment.retryWorkspacePreparation);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  // The thread a send is setting up, recorded by begin() before the server knows it.
  const [startedSetup, setStartedSetup] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly ownerKey: string;
  } | null>(null);
  // Last live snapshot from the setup stream. The server drops a finished
  // snapshot after a grace period and emits null; holding it here bridges the
  // gap until the settled activity arrives on the thread projection.
  const [heldSnapshot, setHeldSnapshot] = useState<WorktreeSetupSnapshot | null>(null);
  const started = startedSetup !== null && startedSetup.ownerKey === ownerKey;
  // Keep the sending environment during local draft setup; revisiting a
  // canonical thread subscribes by its durable identity.
  const target = started ? startedSetup : routeThreadRef;
  const runPreparing = activityRun?.status === "preparing";
  const snapshotQuery = useEnvironmentQuery(
    started ||
      (activeThread?.id === routeThreadRef.threadId &&
        (localPreparing || runPreparing || activeThread.worktreePath !== null))
      ? vcsEnvironment.worktreeSetup({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        })
      : null,
  );
  const latestSnapshot = snapshotQuery.data;
  // A newer snapshot replaces the held one; a late older one for the same
  // thread does not. Switching routes drops it.
  const [heldFor, setHeldFor] = useState<{
    readonly routeThreadRef: ScopedThreadRef;
    readonly latestSnapshot: WorktreeSetupSnapshot | null | undefined;
  }>({ routeThreadRef, latestSnapshot: null });
  if (heldFor.routeThreadRef !== routeThreadRef || heldFor.latestSnapshot !== latestSnapshot) {
    const routeChanged = heldFor.routeThreadRef !== routeThreadRef;
    setHeldFor({ routeThreadRef, latestSnapshot });
    if (routeChanged) {
      setHeldSnapshot(null);
    } else if (latestSnapshot) {
      setHeldSnapshot((current) =>
        current?.threadId === latestSnapshot.threadId && current.sequence > latestSnapshot.sequence
          ? current
          : latestSnapshot,
      );
    }
  }
  const { snapshot: liveSnapshot, isPreparingWorktree } = resolveWorktreeSetupProgress({
    threadId: target.threadId,
    localPreparing,
    runStatus: activityRun?.status,
    latest: latestSnapshot,
    held: heldSnapshot,
  });
  const worktreeSetup = resolveVisibleWorktreeSetup({
    live: liveSnapshot,
    recorded: null,
    turnStarted: activityRun?.startedAt != null,
    followUpSent,
  });
  // Sends wait for the agent handoff, not for the setup script: an async
  // script keeps the snapshot running while the agent already works, and a
  // follow-up must not be held behind a slow install. Before the first
  // snapshot arrives the starting session stands in for it. Once the server
  // has the thread, a send queues behind the setup run instead.
  const blocksSend =
    !sendQueuesBehindSetup &&
    (worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : isPreparingWorktree);

  // Keyed by content so the timeline context only changes when a retry appears or clears.
  const retryableRunIdsKey = [
    ...workspacePreparationRetryRunIds(
      serverProjection?.runs ?? [],
      serverProjection?.turnItems ?? [],
    ),
  ].join("\n");
  const [retryableRunIds, setRetryableRunIds] = useState({
    key: retryableRunIdsKey,
    ids: new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
  });
  if (retryableRunIds.key !== retryableRunIdsKey) {
    setRetryableRunIds({
      key: retryableRunIdsKey,
      ids: new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
    });
  }

  /** Records the thread a send is about to set up; null when the send needs none. */
  const begin = useStableCallback(
    (thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null) =>
      setStartedSetup(thread === null ? null : { ...thread, ownerKey }),
  );
  /** Cancels a running setup. Resolves true once the server cancelled it. */
  const cancel = useStableCallback(async () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running") return false;
    const result = await cancelWorktreeSetup({
      environmentId: target.environmentId,
      input: { threadId: worktreeSetup.threadId },
    });
    return result._tag === "Success" && result.value.cancelled;
  });
  const retryPreparation = useStableCallback((runId: RunId) => {
    // One retry per failed run: a second click lands after the run is preparing again.
    if (!threadRef || retryingWorkspacePreparationRunIds.has(runId)) return;
    retryingWorkspacePreparationRunIds.add(runId);
    void retryWorkspacePreparation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, runId },
    }).finally(() => retryingWorkspacePreparationRunIds.delete(runId));
  });
  // The setup terminal belongs to the thread that was set up. A failed
  // bootstrap deletes that thread and closes its terminals, so only offer the
  // terminal while the setup thread is still the active one.
  const setupThreadRef =
    worktreeSetup && threadRef && worktreeSetup.threadId === threadRef.threadId ? threadRef : null;
  const openSetupTerminal = setupThreadRef
    ? (terminalId: string) => {
        storeEnsureTerminal(setupThreadRef, terminalId, { open: true, active: true });
      }
    : null;

  return {
    worktreeSetup,
    isPreparingWorktree,
    blocksSend,
    retryableRunIds: retryableRunIds.ids,
    begin,
    cancel,
    retryPreparation,
    openSetupTerminal,
  };
}
