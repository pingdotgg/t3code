import type {
  GuestShareView,
  GuestThreadModel,
  OrchestrationV2AppThread,
  OrchestrationV2CheckpointScope,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
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
const guestCheckpointScope = (
  scope: OrchestrationV2CheckpointScope,
): OrchestrationV2CheckpointScope => ({ ...scope, cwd: HIDDEN });
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

// A workflow's transcript directory and script live on the owner's disk.
const guestSubagent = (subagent: OrchestrationV2Subagent): OrchestrationV2Subagent => {
  const runHandles = subagent.workflow?.runHandles;
  if (subagent.workflow === undefined || runHandles === undefined) return subagent;
  const { transcriptDir: _transcriptDir, scriptPath: _scriptPath, ...guestRunHandles } = runHandles;
  return { ...subagent, workflow: { ...subagent.workflow, runHandles: guestRunHandles } };
};

/** The thread as its guest's stream sends it: without the owner's branches or paths on disk. */
export function projectThreadProjectionForGuest(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    thread: guestThread(projection.thread),
    runs: projection.runs.map(guestRun),
    subagents: projection.subagents.map(guestSubagent),
    providerSessions: projection.providerSessions.map(guestProviderSession),
    checkpointScopes: projection.checkpointScopes.map(guestCheckpointScope),
  };
}

/** A live event as its guest's stream sends it; see projectThreadProjectionForGuest. */
export function projectDomainEventForGuest(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
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
    case "subagent.updated":
      return { ...event, payload: guestSubagent(event.payload) };
    case "provider-session.attached":
    case "provider-session.updated":
      return { ...event, payload: guestProviderSession(event.payload) };
    case "checkpoint-scope.created":
      return { ...event, payload: guestCheckpointScope(event.payload) };
    default:
      return event;
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
