import type { EnvironmentId, PeerLinkThreadPage, ThreadId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** A thread on a linked environment, read through the environment that holds the link. */
export interface LinkedThreadTarget {
  /** The environment this client is connected to, which reads the thread over its link. */
  readonly viaEnvironmentId: EnvironmentId;
  /** The linked environment the thread lives in. */
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** What to call the linked environment and the thread until the first page names them. */
  readonly label: string;
  readonly title: string | null;
}

export type LinkedThreadOpen = "direct" | "linked" | "unavailable";

/**
 * How a client opens a thread on `environmentId` that a thread or link in `viaEnvironmentId`
 * points at. A connection of the client's own always wins, since it can do more than read. Without
 * one, the environment holding the link reads it. A saved environment that neither answers nor is
 * linked still opens directly, where the client says it is offline.
 */
export function resolveLinkedThreadOpen(input: {
  readonly environmentId: EnvironmentId;
  readonly viaEnvironmentId: EnvironmentId;
  /** The client's own saved connection to `environmentId`, when it has one. */
  readonly own: { readonly connected: boolean } | undefined;
  /** Whether `viaEnvironmentId` holds a link to `environmentId`. */
  readonly linked: boolean;
}): LinkedThreadOpen {
  if (input.environmentId === input.viaEnvironmentId) return "direct";
  if (input.own?.connected === true) return "direct";
  if (input.linked) return "linked";
  return input.own === undefined ? "unavailable" : "direct";
}

const hasStringField = <K extends string>(value: unknown, key: K): value is Record<K, string> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)[key] === "string";

type Page = Pick<PeerLinkThreadPage, "label" | "thread" | "items" | "earlierPosition" | "hasMore">;

/** What a linked thread view holds: the pages read so far, as one run of items, oldest first. */
export type LinkedThreadTranscript = Page & {
  /**
   * Where the next forward read continues while the last one left more behind it, else null. A
   * page cut short can end before items already shown, so this is not the last item's position.
   */
  readonly continueAfter: number | null;
};

const continuationOf = (page: Page, fallback: number | null) =>
  page.hasMore ? (page.items.at(-1)?.position ?? fallback) : null;

/**
 * Adds a page to what is shown. An earlier page moves the start back; a later one replaces the
 * items it re-reads, which is how an item still being written gets its new text. Every page
 * carries the thread's current title and status.
 */
export function mergeLinkedThreadPage(
  current: LinkedThreadTranscript | null,
  page: Page,
  direction: "earlier" | "later",
): LinkedThreadTranscript {
  if (current === null) return { ...page, continueAfter: continuationOf(page, null) };
  const byPosition = new Map(current.items.map((item) => [item.position, item]));
  for (const item of page.items) byPosition.set(item.position, item);
  return {
    label: page.label,
    thread: page.thread,
    items: [...byPosition.values()].sort((left, right) => left.position - right.position),
    earlierPosition: direction === "earlier" ? page.earlierPosition : current.earlierPosition,
    hasMore: direction === "later" ? page.hasMore : current.hasMore,
    continueAfter:
      direction === "later" ? continuationOf(page, current.continueAfter) : current.continueAfter,
  };
}

const UNSETTLED_ITEM_STATUSES = new Set(["pending", "running", "waiting"]);
/** How far back a refresh re-reads for items still changing, so a stuck one cannot grow it. */
const REFRESH_WINDOW = 20;

/**
 * The `afterPosition` of the next forward read. While a page left more behind it, that continues
 * from where the page ended. Otherwise it re-reads from the oldest recent item still in progress, since
 * its text and status change in place.
 */
export function linkedThreadRefreshCursor(transcript: LinkedThreadTranscript): number {
  if (transcript.continueAfter !== null) return transcript.continueAfter;
  const last = transcript.items.at(-1)?.position ?? -1;
  const unsettled = transcript.items
    .slice(-REFRESH_WINDOW)
    .find((item) => UNSETTLED_ITEM_STATUSES.has(item.status));
  return unsettled === undefined ? last : unsettled.position - 1;
}

const ACTIVE_THREAD_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export const LINKED_THREAD_ACTIVE_POLL_MS = 2_500;
export const LINKED_THREAD_IDLE_POLL_MS = 15_000;

/** How long an open view waits before its next read: none while catching up, short while the thread works. */
export function linkedThreadPollDelayMs(transcript: Pick<Page, "hasMore" | "thread">): number {
  if (transcript.hasMore) return 0;
  return ACTIVE_THREAD_STATUSES.has(transcript.thread.status)
    ? LINKED_THREAD_ACTIVE_POLL_MS
    : LINKED_THREAD_IDLE_POLL_MS;
}

/** Whether a failed read can succeed later with nothing changed: the linked environment was only out of reach. */
function isLinkedThreadFailureRetryable(error: unknown): boolean {
  if (!hasStringField(error, "_tag") || error._tag !== "PeerLinkThreadReadError") return true;
  return hasStringField(error, "reason") && error.reason === "unreachable";
}

export interface LinkedThreadFailure {
  readonly title: string;
  readonly detail: string;
  /** Whether reading again can succeed without the user changing something first. */
  readonly retryable: boolean;
}

/**
 * A failed read in the user's words. `via` and `label` name the two environments as the client
 * knows them; the server's own label wins once it has answered with one.
 */
export function linkedThreadFailure(
  error: unknown,
  names: { readonly via: string; readonly label: string },
  resolve: MFunctionType = mFallback,
): LinkedThreadFailure {
  const via = names.via;
  const serverMessage = hasStringField(error, "message") ? error.message : "";
  if (!hasStringField(error, "_tag") || error._tag !== "PeerLinkThreadReadError") {
    // An environment from before this read answers with an unknown method.
    return {
      title: resolve(msg("Could not read this thread through {via}", { via })),
      detail:
        serverMessage ||
        resolve(msg("{via} may need an update before it can read linked threads.", { via })),
      retryable: true,
    };
  }
  const retryable = isLinkedThreadFailureRetryable(error);
  const label = hasStringField(error, "label") ? error.label : names.label;
  const reason = hasStringField(error, "reason") ? error.reason : "";
  switch (reason) {
    case "disabled":
      return {
        title: resolve(msg("Linked environments is off on {via}", { via })),
        detail: resolve(
          msg(
            "Turn it on in {via}'s Settings → Labs to read threads on the machines it links to.",
            {
              via,
            },
          ),
        ),
        retryable,
      };
    case "unknown_link":
      return {
        title: resolve(msg("{via} is no longer linked to {label}", { via, label })),
        detail: resolve(
          msg("Link it again in {via}'s Settings → Connections to read its threads from here.", {
            via,
          }),
        ),
        retryable,
      };
    case "expired":
      return {
        title: resolve(msg("The link from {via} to {label} expired", { via, label })),
        detail: resolve(
          msg("Link it again in {via}'s Settings → Connections with a new pairing code.", { via }),
        ),
        retryable,
      };
    case "rejected":
      return {
        title: resolve(msg("{label} refused the read", { label })),
        detail: serverMessage,
        retryable,
      };
    case "thread_not_found":
      return {
        title: resolve(msg("This thread is no longer on {label}", { label })),
        detail: resolve(msg("It may have been deleted there.")),
        retryable,
      };
    case "incompatible":
      return {
        title: resolve(msg("{label} needs an update", { label })),
        detail: serverMessage,
        retryable,
      };
    default:
      return {
        title: resolve(msg("{label} is not answering {via}", { label, via })),
        detail: serverMessage,
        retryable,
      };
  }
}

type Item = PeerLinkThreadPage["items"][number];

export type LinkedThreadItemPresentation =
  | { readonly kind: "user" | "assistant"; readonly text: string; readonly truncated: boolean }
  | {
      readonly kind: "activity";
      readonly summary: string;
      /** What the row opens to show; null when the summary says it all. */
      readonly body: string | null;
      readonly failed: boolean;
      readonly truncated: boolean;
    };

const ACTIVITY_LABELS = {
  reasoning: msg("Thinking"),
  todo_list: msg("Plan"),
  file_search: msg("File search"),
  web_search: msg("Web search"),
  approval_request: msg("Approval request"),
  user_input_request: msg("Question"),
  subagent: msg("Subagent"),
  dynamic_tool: msg("Tool call"),
  compaction: msg("Context compacted"),
  error: msg("Error"),
} as const;

const firstLine = (text: string) => {
  const end = text.indexOf("\n");
  return end === -1
    ? { head: text, rest: null }
    : { head: text.slice(0, end), rest: text.slice(end + 1) };
};

/**
 * How a transcript item reads in a linked thread view: messages in full, everything else as a
 * one-line row that opens. `null` hides items that say nothing to a reader, such as checkpoints.
 */
export function presentLinkedThreadItem(
  item: Pick<Item, "type" | "status" | "title" | "text" | "textTruncated">,
  resolve: MFunctionType = mFallback,
): LinkedThreadItemPresentation | null {
  const text = item.text ?? "";
  const truncated = item.textTruncated;
  if (item.type === "checkpoint") return null;
  if (item.type === "user_message") return { kind: "user", text, truncated };
  if (item.type === "assistant_message" || item.type === "proposed_plan") {
    return text.trim() === "" ? null : { kind: "assistant", text, truncated };
  }
  const failed = item.status === "failed" || item.type === "error";
  if (item.type === "command_execution" || item.type === "file_change") {
    const { head, rest } = firstLine(text);
    return { kind: "activity", summary: head, body: rest, failed, truncated };
  }
  const label = Object.hasOwn(ACTIVITY_LABELS, item.type)
    ? resolve(ACTIVITY_LABELS[item.type as keyof typeof ACTIVITY_LABELS])
    : null;
  const title = item.title?.trim() || null;
  if (label === null && title === null) {
    // Notices and the like are their own text.
    const { head, rest } = firstLine(text);
    return head.trim() === ""
      ? null
      : { kind: "activity", summary: head, body: rest, failed, truncated };
  }
  return {
    kind: "activity",
    summary: label !== null && title !== null ? `${label} · ${title}` : (label ?? title)!,
    body: text.trim() === "" ? null : text,
    failed,
    truncated,
  };
}

export const isLinkedThreadWorking = (transcript: Pick<Page, "thread">): boolean =>
  ACTIVE_THREAD_STATUSES.has(transcript.thread.status);

export interface LinkedThreadCursor {
  readonly beforePosition?: number;
  readonly afterPosition?: number;
}

export type LinkedThreadReadResult =
  | { readonly ok: true; readonly page: Page }
  | { readonly ok: false; readonly error: unknown };

export interface LinkedThreadSessionState {
  readonly transcript: LinkedThreadTranscript | null;
  /** The last read's failure, cleared by the next read that succeeds. */
  readonly error: unknown;
  readonly loadingEarlier: boolean;
}

/**
 * The reads behind one open linked thread view. It reads only while something subscribes, so a
 * view that unmounts stops asking the linked environment at once, and while `isActive` says the
 * view is not being looked at it only waits.
 */
export function createLinkedThreadSession(options: {
  readonly read: (cursor: LinkedThreadCursor) => Promise<LinkedThreadReadResult>;
  /** Runs `run` after `delayMs` and returns how to cancel it. */
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly isActive?: () => boolean;
}) {
  let state: LinkedThreadSessionState = { transcript: null, error: null, loadingEarlier: false };
  const listeners = new Set<() => void>();
  // Bumped on stop and restart, so a read that outlives its view changes nothing.
  let generation = 0;
  let cancelNext: (() => void) | null = null;

  const update = (patch: Partial<LinkedThreadSessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const scheduleNext = (delayMs: number) => {
    cancelNext?.();
    cancelNext = options.schedule(() => {
      cancelNext = null;
      if (options.isActive?.() === false) scheduleNext(LINKED_THREAD_ACTIVE_POLL_MS);
      else void readLatest();
    }, delayMs);
  };

  // Only the newest forward read applies: a retry can start one while another is still out.
  let latestRead = 0;

  const readLatest = async () => {
    const run = generation;
    const read = ++latestRead;
    cancelNext?.();
    cancelNext = null;
    const shown = state.transcript;
    const result = await options.read(
      shown === null ? {} : { afterPosition: linkedThreadRefreshCursor(shown) },
    );
    if (run !== generation || read !== latestRead) return;
    if (!result.ok) {
      update({ error: result.error });
      if (isLinkedThreadFailureRetryable(result.error)) scheduleNext(LINKED_THREAD_IDLE_POLL_MS);
      return;
    }
    // An earlier page may have landed while this read was out.
    const transcript = mergeLinkedThreadPage(state.transcript, result.page, "later");
    update({ transcript, error: null });
    scheduleNext(linkedThreadPollDelayMs(transcript));
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        generation += 1;
        if (options.isActive?.() === false) scheduleNext(LINKED_THREAD_ACTIVE_POLL_MS);
        else void readLatest();
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        generation += 1;
        cancelNext?.();
        cancelNext = null;
        state = { ...state, loadingEarlier: false };
      };
    },
    /** Reads the page before the oldest one shown. */
    loadEarlier: async () => {
      const before = state.transcript?.earlierPosition ?? null;
      if (before === null || state.loadingEarlier) return;
      const run = generation;
      update({ loadingEarlier: true });
      const result = await options.read({ beforePosition: before });
      if (run !== generation) return;
      update(
        result.ok
          ? {
              transcript: mergeLinkedThreadPage(state.transcript, result.page, "earlier"),
              error: null,
              loadingEarlier: false,
            }
          : { error: result.error, loadingEarlier: false },
      );
    },
    /** Reads again now, after a failure the user asked to retry. */
    retry: () => {
      if (listeners.size > 0) void readLatest();
    },
  };
}

export type LinkedThreadSession = ReturnType<typeof createLinkedThreadSession>;
