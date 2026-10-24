import {
  GuestStreamEvent,
  type GuestMessageId,
  type GuestShareView,
  type GuestTranscriptItem,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface GuestStreamState {
  readonly view: GuestShareView | null;
  readonly items: ReadonlyArray<GuestTranscriptItem>;
  readonly ended: boolean;
  /**
   * Messages this page saw waiting that have no transcript row yet. Survives reconnects, and a
   * message leaves once its row arrives, so a later bounded snapshot cannot bring it back.
   */
  readonly awaitingRowIds: ReadonlySet<GuestMessageId>;
}

export const initialGuestStreamState: GuestStreamState = {
  view: null,
  items: [],
  ended: false,
  awaitingRowIds: new Set(),
};

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
  items: ReadonlyArray<GuestTranscriptItem>,
): ReadonlySet<GuestMessageId> {
  const placed = items.flatMap((item) =>
    item.kind === "user" && item.guestMessageId && awaiting.has(item.guestMessageId)
      ? [item.guestMessageId]
      : [],
  );
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
    case "snapshot":
      // Another tab redeemed a newer link, and the shared cookie now opens that thread.
      if (state.view !== null && state.view.shareId !== event.view.shareId) {
        return { ...state, ended: true };
      }
      return {
        view: event.view,
        items: event.items,
        ended: false,
        awaitingRowIds: withoutPlaced(
          withPendingFrom(state.awaitingRowIds, event.view),
          event.items,
        ),
      };
    case "item": {
      const exists = state.items.some((item) => item.id === event.item.id);
      return {
        ...state,
        items: exists
          ? state.items.map((item) => (item.id === event.item.id ? event.item : item))
          : [...state.items, event.item],
        awaitingRowIds: withoutPlaced(state.awaitingRowIds, [event.item]),
      };
    }
    case "append":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === event.id && "text" in item
            ? { ...item, text: item.text + event.text, streaming: event.streaming }
            : item,
        ),
      };
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

/**
 * The guest's messages to show after the transcript, oldest first. Pending ones always show. A
 * sent or dismissed one shows only while it awaits a row (see `awaitingRowIds`): a queued send, or
 * a dismissal to report. The transcript is a bounded window, so any other resolved message is old
 * history, not something to place at the end.
 */
export function unplacedGuestMessages(
  messages: ReadonlyArray<ThreadGuestMessage>,
  items: ReadonlyArray<GuestTranscriptItem>,
  awaitingRowIds: ReadonlySet<GuestMessageId>,
): ReadonlyArray<ThreadGuestMessage> {
  const placed = new Set(
    items.flatMap((item) =>
      item.kind === "user" && item.guestMessageId ? [item.guestMessageId] : [],
    ),
  );
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

type GuestTool = Extract<GuestTranscriptItem, { kind: "tool" }>["tool"];

/** A run of tool calls between two messages shows as one line, as the app's work log does. */
export type GuestTranscriptRow =
  | { readonly kind: "item"; readonly item: GuestTranscriptItem }
  | { readonly kind: "work"; readonly id: string; readonly line: string };

const WORK_PHRASES: Record<GuestTool, (count: number) => string> = {
  command: (count) => (count === 1 ? "ran a command" : `ran ${count} commands`),
  file_change: () => "edited files",
  file_search: () => "searched files",
  web_search: () => "searched the web",
  tool: (count) => (count === 1 ? "used a tool" : `used ${count} tools`),
  subagent: (count) => (count === 1 ? "ran a subagent" : `ran ${count} subagents`),
};

/** "Ran 8 commands, edited files": each kind once, in the order it first ran. */
function formatGuestWork(tools: ReadonlyArray<GuestTool>): string {
  const counts = new Map<GuestTool, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const line = [...counts].map(([tool, count]) => WORK_PHRASES[tool](count)).join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function groupGuestTranscript(
  items: ReadonlyArray<GuestTranscriptItem>,
): ReadonlyArray<GuestTranscriptRow> {
  const rows: GuestTranscriptRow[] = [];
  let work: { id: string; tools: GuestTool[] } | null = null;
  const flush = () => {
    if (work !== null) rows.push({ kind: "work", id: work.id, line: formatGuestWork(work.tools) });
    work = null;
  };
  for (const item of items) {
    if (item.kind === "tool") {
      if (work === null) work = { id: item.id, tools: [] };
      work.tools.push(item.tool);
      continue;
    }
    flush();
    rows.push({ kind: "item", item });
  }
  flush();
  return rows;
}
