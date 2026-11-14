import type {
  GuestShareView,
  GuestThreadModel,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2Run,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2ThreadProjection,
  ServerProvider,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

// Stands in for paths and refs the schema requires but the guest page never reads.
const HIDDEN = ".";

// Clients read a link's state and watch, not its branches.
const guestPullRequestLink = (link: ThreadPullRequestLink): ThreadPullRequestLink => ({
  ...link,
  snapshot:
    link.snapshot === null ? null : { ...link.snapshot, headBranch: HIDDEN, baseBranch: HIDDEN },
  stack:
    link.stack === null
      ? null
      : {
          ...link.stack,
          base: HIDDEN,
          layers: link.stack.layers.map((layer) => ({ ...layer, headBranch: HIDDEN })),
        },
});
const guestThread = (thread: OrchestrationV2AppThread): OrchestrationV2AppThread => ({
  ...thread,
  branch: null,
  worktreePath: null,
  ...(thread.pullRequests === undefined
    ? {}
    : { pullRequests: thread.pullRequests.map(guestPullRequestLink) }),
});
const guestProviderSession = (
  session: OrchestrationV2ProviderSession,
): OrchestrationV2ProviderSession => ({ ...session, cwd: HIDDEN });
// Clients read only the strategy's type.
const guestWorkspacePreparation = (
  preparation: OrchestrationV2ThreadLaunchWorkspaceStrategy,
): OrchestrationV2ThreadLaunchWorkspaceStrategy => {
  switch (preparation.type) {
    case "root":
      return { type: "root" };
    case "existing_worktree":
      return { type: "existing_worktree", worktreePath: HIDDEN };
    case "worktree":
      return { type: "worktree", baseRef: HIDDEN };
  }
};
const guestRun = (run: OrchestrationV2Run): OrchestrationV2Run =>
  run.workspacePreparation === undefined
    ? run
    : { ...run, workspacePreparation: guestWorkspacePreparation(run.workspacePreparation) };

/**
 * The thread as its guest's stream sends it: without the owner's branches or paths on disk, and
 * without the records the guest page never reads (subagents, checkpoints, context transfers).
 */
export function projectThreadProjectionForGuest(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    thread: guestThread(projection.thread),
    runs: projection.runs.map(guestRun),
    subagents: [],
    providerSessions: projection.providerSessions.map(guestProviderSession),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
  };
}

/**
 * A live event as its guest's stream sends it, or null when the guest page has no use for it;
 * see projectThreadProjectionForGuest. Every event type is listed, so a new one needs a decision.
 */
export function projectDomainEventForGuest(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent | null {
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.auto-settle-set":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.tags-updated":
    case "thread.visited":
    case "thread.marked-unread":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.guest-share-updated":
      return { ...event, payload: guestThread(event.payload) };
    case "thread.pull-request-link-updated":
      return { ...event, payload: guestPullRequestLink(event.payload) };
    case "run.created":
    case "run.updated":
      return { ...event, payload: guestRun(event.payload) };
    case "provider-session.attached":
    case "provider-session.updated":
      return { ...event, payload: guestProviderSession(event.payload) };
    case "run.background-work-cancelled":
    case "run-attempt.created":
    case "run-attempt.updated":
    case "node.updated":
    case "provider-session.detached":
    case "provider-thread.updated":
    case "provider-turn.updated":
    case "runtime-request.updated":
    case "message.updated":
    case "plan.updated":
    case "turn-item.updated":
      return event;
    case "subagent.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
      return null;
  }
}

/** The thread's model as the owner's composer labels it, from the configured providers. */
export function guestThreadModel(
  selection: OrchestrationV2AppThread["modelSelection"],
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">>,
): GuestThreadModel {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return {
    driver: provider?.driver ?? null,
    name: model?.name ?? selection.model,
    ...(model?.shortName === undefined ? {} : { shortName: model.shortName }),
    ...(model?.subProvider === undefined ? {} : { subProvider: model.subProvider }),
  };
}

/** The share as its guest sees it, or null before the guest has joined. */
export function guestShareView(
  thread: OrchestrationV2AppThread,
  model: GuestThreadModel,
): GuestShareView | null {
  const share = thread.guestShare;
  if (!share || share.guestName === null) return null;
  return {
    shareId: share.id,
    title: thread.title,
    guestName: share.guestName,
    expiresAt: share.expiresAt,
    messages: share.messages,
    model,
  };
}
