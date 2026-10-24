import {
  GUEST_ATTACHMENT_ROUTE,
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  GUEST_SHARE_PARAM,
  GuestStreamEvent,
  isProviderSendTurnSupportedImageMimeType,
  type GuestMessageId,
  type GuestRun,
  type GuestShareView,
  type GuestTurnItem,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface GuestStreamState {
  readonly view: GuestShareView | null;
  readonly runs: ReadonlyArray<GuestRun>;
  /** In the shape the real timeline reads. A guest only ever gets this thread's own items. */
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly ended: boolean;
  /**
   * Messages this page saw waiting that have no transcript row yet. Survives reconnects, and a
   * message leaves once its row arrives, so a later bounded snapshot cannot bring it back.
   */
  readonly awaitingRowIds: ReadonlySet<GuestMessageId>;
}

export const initialGuestStreamState: GuestStreamState = {
  view: null,
  runs: [],
  items: [],
  ended: false,
  awaitingRowIds: new Set(),
};

const projectedItem = (
  item: GuestTurnItem,
  position: number,
): OrchestrationV2ProjectedTurnItem => ({
  position,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});

/** Replaces the row with the item's id, or adds it at the end. Other rows keep their identity. */
function upsertItem(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  item: GuestTurnItem,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  const index = items.findIndex((row) => row.item.id === item.id);
  return index === -1
    ? [...items, projectedItem(item, items.length)]
    : items.with(index, projectedItem(item, items[index]!.position));
}

function upsertRun(runs: ReadonlyArray<GuestRun>, run: GuestRun): ReadonlyArray<GuestRun> {
  const index = runs.findIndex((existing) => existing.id === run.id);
  return index === -1 ? [...runs, run] : runs.with(index, run);
}

const guestMessageIdOf = (item: OrchestrationV2TurnItem) =>
  item.type === "user_message" ? item.context?.guest?.guestMessageId : undefined;

function withPendingFrom(
  awaiting: ReadonlySet<GuestMessageId>,
  view: GuestShareView,
): ReadonlySet<GuestMessageId> {
  const pending = view.messages.filter((message) => message.status === "pending");
  if (pending.every((message) => awaiting.has(message.id))) return awaiting;
  return new Set([...awaiting, ...pending.map((message) => message.id)]);
}

function withoutPlaced(
  awaiting: ReadonlySet<GuestMessageId>,
  items: ReadonlyArray<GuestTurnItem>,
): ReadonlySet<GuestMessageId> {
  const placed = items.flatMap((item) => {
    const id = guestMessageIdOf(item);
    return id !== undefined && awaiting.has(id) ? [id] : [];
  });
  if (placed.length === 0) return awaiting;
  const next = new Set(awaiting);
  for (const id of placed) next.delete(id);
  return next;
}

const decodeGuestStreamEvent = Schema.decodeUnknownOption(Schema.fromJsonString(GuestStreamEvent));

/** Returns null for anything the server would never send, so a bad frame is skipped, not fatal. */
export const parseGuestStreamEvent = (data: string): GuestStreamEvent | null =>
  Option.getOrNull(decodeGuestStreamEvent(data));

/**
 * A reconnect starts with a fresh snapshot, so `snapshot` replaces everything and later events
 * only patch what it delivered.
 */
export function applyGuestStreamEvent(
  state: GuestStreamState,
  event: GuestStreamEvent,
): GuestStreamState {
  switch (event.type) {
    case "snapshot": {
      // Another tab redeemed a newer link, and the shared cookie now opens that thread.
      if (state.view !== null && state.view.shareId !== event.view.shareId) {
        return { ...state, ended: true };
      }
      return {
        view: event.view,
        runs: event.runs,
        items: event.items.map(projectedItem),
        ended: false,
        awaitingRowIds: withoutPlaced(
          withPendingFrom(state.awaitingRowIds, event.view),
          event.items,
        ),
      };
    }
    case "item":
      return {
        ...state,
        items: upsertItem(state.items, event.item),
        awaitingRowIds: withoutPlaced(state.awaitingRowIds, [event.item]),
      };
    case "run":
      return { ...state, runs: upsertRun(state.runs, event.run) };
    case "view":
      return {
        ...state,
        view: event.view,
        awaitingRowIds: withPendingFrom(state.awaitingRowIds, event.view),
      };
    case "ended":
      return { ...state, ended: true };
  }
}

const WORKING_RUN_STATUSES: ReadonlySet<GuestRun["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export interface GuestActivity {
  readonly isWorking: boolean;
  /** The run the working row and turn folding follow, as the owner's timeline gets it. */
  readonly run: ThreadRunSummary | null;
  readonly workStartedAt: string | null;
}

/**
 * The newest working run, or else the newest run that left the queue. The same choice the owner's
 * view makes from its projection (see deriveThreadActivityRun).
 */
export function deriveGuestActivity(runs: ReadonlyArray<GuestRun>): GuestActivity {
  let working: GuestRun | null = null;
  let latest: GuestRun | null = null;
  for (const run of runs) {
    if (
      WORKING_RUN_STATUSES.has(run.status) &&
      (working === null || run.ordinal > working.ordinal)
    ) {
      working = run;
    }
    if (run.status !== "queued" && (latest === null || run.ordinal > latest.ordinal)) latest = run;
  }
  const run = working ?? latest;
  return {
    isWorking: working !== null,
    run:
      run === null
        ? null
        : {
            runId: run.id,
            status: run.status,
            requestedAt: run.requestedAt,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            assistantMessageId: null,
            ...(run.turnEnded ? { turnEnded: true } : {}),
          },
    workStartedAt: working?.workStartedAt ?? null,
  };
}

/**
 * The guest's messages to show after the transcript, oldest first. Pending ones always show. A
 * sent or dismissed one shows only while it awaits a row (see `awaitingRowIds`): a queued send, or
 * a dismissal to report. The transcript is a bounded window, so any other resolved message is old
 * history, not something to place at the end.
 */
export function unplacedGuestMessages(
  messages: ReadonlyArray<ThreadGuestMessage>,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  awaitingRowIds: ReadonlySet<GuestMessageId>,
): ReadonlyArray<ThreadGuestMessage> {
  const placed = new Set(items.flatMap((row) => guestMessageIdOf(row.item) ?? []));
  return messages
    .filter(
      (message) =>
        !placed.has(message.id) && (message.status === "pending" || awaitingRowIds.has(message.id)),
    )
    .toSorted((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** "23h left" or "5m left", rounded down, for the guest page header. */
export function formatGuestExpiry(expiresAt: string, nowMs: number): string {
  const minutes = Math.floor((Date.parse(expiresAt) - nowMs) / 60_000);
  if (minutes <= 0) return "Expired";
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h left` : `${minutes}m left`;
}

/**
 * The share an invite (`<shareId>.<signature>`) opens. Only used to name the share in the page
 * URL and to find this browser's session for it; the server checks the signature.
 */
export function inviteShareId(credential: string): string | null {
  const [shareId, signature] = credential.split(".");
  return shareId && signature ? shareId : null;
}

/** Where the guest page loads one of the guest's own files. */
export const guestAttachmentUrl = (shareId: string, attachmentId: string) =>
  `${GUEST_ATTACHMENT_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&id=${encodeURIComponent(attachmentId)}`;

/**
 * Why these files cannot go with one message, or null. The server checks the same limits; this
 * only says so before the upload.
 */
export function guestFilesProblem(
  files: ReadonlyArray<Pick<File, "type" | "size">>,
): string | null {
  if (files.length > GUEST_MESSAGE_MAX_ATTACHMENTS) {
    return `Attach up to ${GUEST_MESSAGE_MAX_ATTACHMENTS} files to a message.`;
  }
  if (files.reduce((total, file) => total + file.size, 0) > GUEST_MESSAGE_MAX_ATTACHMENT_BYTES) {
    return "Attached files can total up to 10 MB per message.";
  }
  const unsupported = files.some(
    (file) =>
      file.size === 0 ||
      (file.type.toLowerCase().startsWith("image/") &&
        !isProviderSendTurnSupportedImageMimeType(file.type)),
  );
  return unsupported
    ? "This file cannot be attached. Images must be PNG, JPEG, GIF, or WebP."
    : null;
}

/** Image URLs for the guest's own sent messages, which the timeline shows as previews. */
export function guestAttachmentUrlsById(
  shareId: string,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyMap<string, string> {
  return new Map(
    items.flatMap(({ item }) =>
      item.type === "user_message" && item.context?.guest !== undefined
        ? item.attachments.map(
            (attachment) => [attachment.id, guestAttachmentUrl(shareId, attachment.id)] as const,
          )
        : [],
    ),
  );
}
