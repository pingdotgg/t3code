import type {
  GuestShareView,
  GuestThreadModel,
  OrchestrationV2AppThread,
  OrchestrationV2CheckpointScope,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2ThreadProjection,
  ServerProvider,
} from "@t3tools/contracts";

// The schema requires a cwd; the guest page never reads one.
const GUEST_CWD = ".";

const guestThread = (thread: OrchestrationV2AppThread): OrchestrationV2AppThread => ({
  ...thread,
  branch: null,
  worktreePath: null,
});
const guestProviderSession = (
  session: OrchestrationV2ProviderSession,
): OrchestrationV2ProviderSession => ({ ...session, cwd: GUEST_CWD });
const guestCheckpointScope = (
  scope: OrchestrationV2CheckpointScope,
): OrchestrationV2CheckpointScope => ({ ...scope, cwd: GUEST_CWD });

/** The thread as its guest's stream sends it: without the owner's branch or paths on disk. */
export function projectThreadProjectionForGuest(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    thread: guestThread(projection.thread),
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
