import {
  GUEST_ATTACHMENT_ROUTE,
  GUEST_MEDIA_ROUTE,
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  GUEST_SHARE_PARAM,
  GuestStreamEvent,
  isProviderSendTurnSupportedImageMimeType,
  type GuestMessageId,
  type GuestShareView,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { mergeOlderHistoryIntoProjection } from "@t3tools/client-runtime/state/thread-history-merge";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface GuestStreamState {
  readonly view: GuestShareView | null;
  /** The thread as the owner's client holds it, built with the same reducer. */
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly sequence: number;
  /** Set while the snapshot is a window of a longer history, as the owner's client tracks it. */
  readonly partial: { readonly latestLocalTurnOrdinal: number | null } | null;
  /** Where "Load earlier turns" continues, or null once the whole thread is loaded. */
  readonly historyCursor: string | null;
  readonly ended: boolean;
  /**
   * Messages this page saw waiting that have no transcript row yet. Survives reconnects, and a
   * message leaves once its row arrives, so a later bounded snapshot cannot bring it back.
   */
  readonly awaitingRowIds: ReadonlySet<GuestMessageId>;
}

export const initialGuestStreamState: GuestStreamState = {
  view: null,
  projection: null,
  sequence: 0,
  partial: null,
  historyCursor: null,
  ended: false,
  awaitingRowIds: new Set(),
};

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
  items: ReadonlyArray<OrchestrationV2TurnItem>,
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

const decodeGuestStreamEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(GuestStreamEvent)),
);

/** Returns null for anything the server would never send, so a bad frame is skipped, not fatal. */
export const parseGuestStreamEvent = (data: string): GuestStreamEvent | null =>
  Option.getOrNull(decodeGuestStreamEvent(data));

/** A page of older turns, fetched from `cursor`. */
export type GuestHistoryPageLoaded = {
  readonly type: "history-page";
  readonly cursor: string;
  readonly page: OrchestrationV2ThreadHistoryPage;
};

/** The guest closed a message the owner chose not to send. */
export type GuestMessageCleared = {
  readonly type: "message-cleared";
  readonly id: GuestMessageId;
};

/**
 * Applies the owner's thread stream the way the owner's client does (see
 * EnvironmentThreadState in client-runtime): a snapshot replaces the thread, and later events
 * pass through the same projection reducer, once each. Older pages merge in front, as they do in
 * the owner's view.
 */
export function applyGuestStreamEvent(
  state: GuestStreamState,
  event: GuestStreamEvent | GuestHistoryPageLoaded | GuestMessageCleared,
): GuestStreamState {
  switch (event.type) {
    case "message-cleared": {
      if (!state.awaitingRowIds.has(event.id)) return state;
      const awaitingRowIds = new Set(state.awaitingRowIds);
      awaitingRowIds.delete(event.id);
      return { ...state, awaitingRowIds };
    }
    case "history-page":
      // A snapshot since the request replaced the thread and its cursor.
      if (state.projection === null || state.historyCursor !== event.cursor) return state;
      return {
        ...state,
        projection: mergeOlderHistoryIntoProjection(state.projection, event.page.items),
        historyCursor: event.page.hasMoreHistory ? event.page.nextCursor : null,
      };
    case "view":
      // The page follows the share it names; a view of another one means the link changed.
      if (state.view !== null && state.view.shareId !== event.view.shareId) {
        return { ...state, ended: true };
      }
      return {
        ...state,
        view: event.view,
        awaitingRowIds: withPendingFrom(state.awaitingRowIds, event.view),
      };
    case "thread": {
      const item = event.item;
      if (item.kind === "snapshot") {
        const projection = boundedSnapshotProjection(item);
        return {
          ...state,
          projection,
          sequence: item.snapshotSequence,
          partial:
            item.hasMoreHistory === true || (item.historyCursor ?? null) !== null
              ? { latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null }
              : null,
          historyCursor: item.hasMoreHistory === true ? (item.historyCursor ?? null) : null,
          awaitingRowIds: withoutPlaced(
            state.awaitingRowIds,
            projection.visibleTurnItems.map((row) => row.item),
          ),
        };
      }
      if (item.kind === "synchronized" || item.sequence <= state.sequence) return state;
      if (item.kind === "unknown-event") return { ...state, sequence: item.sequence };
      const projection =
        applyOrchestrationV2ProjectionEvent(
          state.projection,
          item.event,
          state.partial === null ? undefined : { partialTimeline: true, ...state.partial },
        ) ?? state.projection;
      const turnItem = item.event.type === "turn-item.updated" ? item.event.payload : null;
      const watermark = state.partial?.latestLocalTurnOrdinal ?? null;
      return {
        ...state,
        projection,
        sequence: item.sequence,
        partial:
          state.partial !== null &&
          turnItem !== null &&
          (watermark === null || turnItem.ordinal > watermark)
            ? { latestLocalTurnOrdinal: turnItem.ordinal }
            : state.partial,
        awaitingRowIds:
          turnItem === null
            ? state.awaitingRowIds
            : withoutPlaced(state.awaitingRowIds, [turnItem]),
      };
    }
    case "ended":
      return { ...state, ended: true };
  }
}

/**
 * The guest's messages to show after the transcript, oldest first. Pending ones always show. A
 * sent or dismissed one shows only while it awaits a row (see `awaitingRowIds`): a queued send, or
 * a dismissal to report until the guest clears it. The transcript is a bounded window, so any
 * other resolved message is old history, not something to place at the end.
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

/** Where the guest page loads a file of the shared thread or of a waiting message. */
export const guestAttachmentUrl = (shareId: string, attachmentId: string) =>
  `${GUEST_ATTACHMENT_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&id=${encodeURIComponent(attachmentId)}`;

/** Where the guest page loads an image file on the host that an agent message embeds. */
export const guestMediaUrl = (shareId: string, path: string) =>
  `${GUEST_MEDIA_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&path=${encodeURIComponent(path)}`;

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

/**
 * Image URLs for the thread's messages, which the timeline shows as previews. The map keeps its
 * identity while the rows do, because the timeline rebuilds its entries when it changes.
 */
export function createGuestAttachmentUrls(shareId: string) {
  let previousItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> | null = null;
  let previous: ReadonlyMap<string, string> = new Map();
  return (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>): ReadonlyMap<string, string> => {
    if (items === previousItems) return previous;
    previousItems = items;
    previous = new Map(
      items.flatMap(({ item }) =>
        item.type === "user_message"
          ? item.attachments.map(
              (attachment) => [attachment.id, guestAttachmentUrl(shareId, attachment.id)] as const,
            )
          : [],
      ),
    );
    return previous;
  };
}
