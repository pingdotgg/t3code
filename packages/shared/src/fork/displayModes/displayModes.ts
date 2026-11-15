import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import { assistantCitationsToPlainText } from "../../assistantCitations.ts";
import { resolveT3McpToolId } from "../../t3McpToolPresentation.ts";
import { compactDynamicToolOutput } from "../../toolOutput.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
export const REPLACE_SEND_TO_USER_TOOL_NAME = "replace_send_to_user";
/**
 * A SQL LIKE pattern for the stored payload of a `send_to_user` call. It ends the name with
 * `send_to_user`, so it also selects `replace_send_to_user` calls, which change a send's text.
 */
export const SEND_TO_USER_PAYLOAD_LIKE = `%"toolName":"%${SEND_TO_USER_TOOL_NAME}"%`;
/** One concise point per message: a longer send or rewrite is refused. */
export const SEND_TO_USER_MAX_BYTES = 1_000;
/** An ack only says that the agent got the message and is on it. */
export const ACK_MAX_BYTES = 200;
export const DASHBOARD_SET_TOOL_NAME = "dashboard_set";
export const DASHBOARD_GET_TOOL_NAME = "dashboard_get";

/** The kind of the context record that a user's reply carries: `{ first }`, the id of its sub-thread's first message. */
export const SUB_THREAD_RECORD_KIND = "fork-reply";
/** How many of the thread's latest messages the server reads to place a message in its sub-thread. */
export const SUB_THREAD_WINDOW_CORES = 120;
/** How many unanswered or unreplied messages a refusal lists. */
export const SUB_THREAD_LISTED_COUNT = 5;

const WRAPPED_CORE_MAX_BYTES = 2_000;
/** How many of the latest shown messages a wrapped message lists. */
export const WRAPPED_CORE_COUNT = 3;

/**
 * A thread's history as a display mode sees it. Web timeline entries and
 * server turn items both map to this list, so the screen and the wrapper
 * agree on what the user saw.
 */
export type DisplayEvent =
  /** `under` is the id of the first message that the user replied under. Without it, the message is a first message. */
  | {
      readonly type: "user";
      readonly id: string;
      readonly text: string;
      readonly under?: string | undefined;
    }
  /**
   * `replyTo` is the short id of the user message that the send answers. Without it, the send is a
   * first message, and `pointer` is the short id that the send returned for it, when it returned one.
   * `ack` marks a note that the agent got the message, sent before its answer.
   */
  | {
      readonly type: "sent";
      readonly id: string;
      readonly text: string;
      readonly replyTo?: string | undefined;
      readonly pointer?: string | undefined;
      readonly ack?: true;
    }
  /**
   * A completed `replace_send_to_user` call. With `replyTo`, the latest answer to that user message
   * now reads `text`. With `subThread`, the agent's first message with that short id does. With
   * neither, the latest `sent` before it does.
   */
  | {
      readonly type: "rewrite";
      readonly id: string;
      readonly text: string;
      readonly replyTo?: string | undefined;
      readonly subThread?: string | undefined;
    }
  /**
   * Anything else that entered the agent's transcript, such as its plain text, reasoning, tool work,
   * and messages the user did not type.
   */
  | { readonly type: "other" };

/** Whether `event` is a message of the main list in a thread with sub-threads, not a reply. */
export const isMainListEvent = (event: DisplayEvent): boolean =>
  (event.type === "user" && event.under === undefined) ||
  (event.type === "sent" && event.replyTo === undefined);

/** A core is one message that a display mode shows, from the user or from the agent. */
export interface VisibleCore {
  readonly id: string;
  readonly from: "user" | "agent";
  readonly text: string;
  /**
   * The id of the first message of the core's sub-thread: its own id for a first message, and null
   * for an agent's reply to a user message that is not among the events.
   */
  readonly first: string | null;
  /** Whether the core is a reply. A reply shows in its sub-thread, not in the main list. */
  readonly reply: boolean;
  /**
   * The id that the agent names the core by: for a user message, a hash of its id; for the agent's
   * first message, the id that its send returned, which the stored call keeps, or a hash of the
   * text it was sent with when the send returned none. An agent's reply has none.
   */
  readonly shortId?: string | undefined;
  /** For an agent's reply, the short id of the user message that it answers. */
  readonly replyTo?: string | undefined;
  /** An ack that no rewrite has made the answer yet. */
  readonly ack?: true;
  /** The id of the latest rewrite that changed the core's text. */
  readonly editedBy?: string;
}

/** Six hex digits of the FNV-1a hash of `text`. The agent names a message by this. */
export function shortId(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

export interface DisplayMode {
  readonly id: string;
  readonly label: string;
  /**
   * Goes before the first message that the user types after the thread switches to this mode. A new
   * thread starts as Normal, so its first message in another mode gets that mode's note.
   */
  readonly notice: string;
  /** States the mode to an agent whose conversation was just compacted, which may have dropped `notice`. */
  readonly stateNotice: string;
  /** Null keeps the whole timeline. */
  readonly visibleCores: ((events: ReadonlyArray<DisplayEvent>) => VisibleCore[]) | null;
  /**
   * Returns the text that the agent gets for the user's `message` after `events`. Null sends it
   * unchanged. `events` may leave out events, as long as it keeps their order, the latest
   * WRAPPED_CORE_COUNT `user` and `sent` events, and every `rewrite` after the first of those.
   * A mode with sub-threads counts those in the message's sub-thread, and needs its first message.
   */
  readonly wrap:
    | ((events: ReadonlyArray<DisplayEvent>, text: string, message: WrappedMessage) => string)
    | null;
  /** Whether the thread has a Dashboard that the user sees and the agent writes. */
  readonly dashboard: boolean;
  /**
   * Whether the agent may send one answer after each message that the user types, after at most
   * one ack. To say more, it rewrites its latest message with `replace_send_to_user`.
   */
  readonly oneSendPerMessage: boolean;
  /**
   * Whether each first message has a sub-thread of replies. The main list then shows the cores that
   * are not replies, and the agent answers a user message by its short id.
   */
  readonly subThreads: boolean;
}

/** The user's message that a mode wraps: its id, and the first message that it replies under. */
export interface WrappedMessage {
  readonly id: string;
  readonly under?: string | undefined;
}

/**
 * A short id for a first message that the agent sends with `text`: one that is not in `taken`,
 * the ids of the shown messages and of the sends not stored yet. The send returns it and its
 * stored call keeps it, so it stays the message's id for good.
 */
export function freshFirstPointer(taken: ReadonlySet<string | undefined>, text: string): string {
  let id = shortId(text);
  for (let attempt = 1; taken.has(id); attempt++) id = shortId(`${text}\n${attempt}`);
  return id;
}

/**
 * A message id as the agent passed it to a tool: with no space around it, and undefined for an
 * empty one, which an agent may send for "none". The tools and the fold read every id through this.
 */
export const messagePointer = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * The messages that `events` show, in order. Each `user` and `sent` event adds one; a `rewrite`
 * sets the text of the `sent` it names, or of the latest `sent` before it, and adds none. A rewrite
 * always leaves an answer, so it ends an ack. A rewrite whose send is not among the events, such as
 * one on a history page not loaded yet, shows nothing and goes to `onUnmatched`.
 */
export function foldCores(
  events: Iterable<DisplayEvent>,
  onUnmatched?: (rewrite: Extract<DisplayEvent, { readonly type: "rewrite" }>) => void,
): VisibleCore[] {
  const cores: VisibleCore[] = [];
  let latestSent: number | undefined;
  const userByShortId = new Map<string, number>();
  const answerByReplyTo = new Map<string, number>();
  const agentFirstByShortId = new Map<string, number>();
  for (const event of events) {
    switch (event.type) {
      case "user": {
        const id = shortId(event.id);
        userByShortId.set(
          id,
          cores.push({
            id: event.id,
            from: "user",
            text: event.text,
            first: event.under ?? event.id,
            reply: event.under !== undefined,
            shortId: id,
          }) - 1,
        );
        break;
      }
      case "sent":
        if (event.replyTo === undefined) {
          const id = event.pointer ?? shortId(event.text);
          latestSent =
            cores.push({
              id: event.id,
              from: "agent",
              text: event.text,
              first: event.id,
              reply: false,
              shortId: id,
              ...(event.ack && { ack: event.ack }),
            }) - 1;
          agentFirstByShortId.set(id, latestSent);
        } else {
          const answered = userByShortId.get(event.replyTo);
          latestSent =
            cores.push({
              id: event.id,
              from: "agent",
              text: event.text,
              first: answered === undefined ? null : cores[answered]!.first,
              reply: true,
              replyTo: event.replyTo,
              ...(event.ack && { ack: event.ack }),
            }) - 1;
          answerByReplyTo.set(event.replyTo, latestSent);
        }
        break;
      case "rewrite": {
        const target =
          event.replyTo !== undefined
            ? answerByReplyTo.get(event.replyTo)
            : event.subThread !== undefined
              ? agentFirstByShortId.get(event.subThread)
              : latestSent;
        if (target === undefined) {
          onUnmatched?.(event);
          break;
        }
        const { ack: _ack, ...core } = cores[target]!;
        cores[target] =
          core.text === event.text ? core : { ...core, text: event.text, editedBy: event.id };
        break;
      }
      case "other":
        break;
    }
  }
  return cores;
}

/** The cores of the sub-thread whose first message has the id `first`, in order. */
export const subThreadCores = (
  cores: ReadonlyArray<VisibleCore>,
  first: string,
): ReadonlyArray<VisibleCore> => cores.filter((core) => core.first === first);

/** The first message of a sub-thread and its latest WRAPPED_CORE_COUNT other messages, as a recap shows them. */
export function subThreadRecap(thread: ReadonlyArray<VisibleCore>): ReadonlyArray<VisibleCore> {
  const first = thread.find((core) => !core.reply);
  const replies = thread.filter((core) => core !== first).slice(-WRAPPED_CORE_COUNT);
  return first === undefined ? replies : [first, ...replies];
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > maxBytes) break;
    kept += character;
  }
  return `${kept}…[truncated]`;
}

/** A message as a recap shows it: each quote as its quoted text and comment, cut at 2000 bytes. */
export function recapText(text: string): string {
  return truncateUtf8(assistantCitationsToPlainText(text), WRAPPED_CORE_MAX_BYTES);
}

/** One line of a recap, such as `[you] Done.` */
export const recapLine = (core: VisibleCore): string =>
  `[${core.from === "user" ? "user" : "you"}] ${recapText(core.text)}`;

export const NORMAL_DISPLAY_MODE: DisplayMode = {
  id: "normal",
  label: "Normal",
  notice:
    "<t3-display-mode>The user switched this thread back to the full view. They see your replies and tool calls again; reply as usual, not only through send_to_user.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in the full view. The user sees your replies and tool calls; reply as usual, not only through send_to_user.</t3-display-mode>",
  visibleCores: null,
  wrap: null,
  dashboard: false,
  oneSendPerMessage: false,
  subThreads: false,
};

function messagesOnlyWrap(events: ReadonlyArray<DisplayEvent>, text: string): string {
  // Every message recaps the latest shown messages, so the agent always knows what the user saw,
  // whatever else entered its transcript. A message with nothing shown before it has no recap.
  const shown = foldCores(events).slice(-WRAPPED_CORE_COUNT);
  if (shown.length === 0) return text;
  return [
    "<t3-messages-mode>",
    "This message is from the user. Before it, their screen showed:",
    ...shown.map(recapLine),
    "</t3-messages-mode>",
    text,
  ].join("\n");
}

export const MESSAGES_ONLY_DISPLAY_MODE: DisplayMode = {
  id: "messages-only",
  label: "Messages only",
  notice:
    "<t3-display-mode>The user switched this thread to Messages only. From now on they see only their own messages and your send_to_user messages; reply with send_to_user.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in Messages only. The user sees only their own messages and your send_to_user messages; reply with send_to_user.</t3-display-mode>",
  visibleCores: foldCores,
  wrap: messagesOnlyWrap,
  dashboard: false,
  oneSendPerMessage: true,
  subThreads: false,
};

export const MESSAGES_DASHBOARD_DISPLAY_MODE: DisplayMode = {
  id: "messages-dashboard",
  label: "Messages + Dashboard",
  notice:
    "<t3-display-mode>The user switched this thread to Messages + Dashboard. They see only their own messages and your send_to_user messages; reply with send_to_user. They also see this thread's Dashboard, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in Messages + Dashboard. The user sees only their own messages and your send_to_user messages; reply with send_to_user. They also see this thread's Dashboard, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.</t3-display-mode>",
  visibleCores: foldCores,
  wrap: messagesOnlyWrap,
  dashboard: true,
  oneSendPerMessage: true,
  subThreads: false,
};

function chatRepliesWrap(
  events: ReadonlyArray<DisplayEvent>,
  text: string,
  message: WrappedMessage,
): string {
  const id = shortId(message.id);
  const shown =
    message.under === undefined
      ? []
      : subThreadRecap(subThreadCores(foldCores(events), message.under));
  return [
    "<t3-replies-mode>",
    message.under === undefined
      ? `Message "${id}" from the user, a new message in the main list.`
      : shown.length === 0
        ? `Message "${id}" from the user, a reply in a sub-thread.`
        : `Message "${id}" from the user, a reply in the sub-thread that showed:`,
    ...shown.map(recapLine),
    `To answer, call send_to_user with reply_to "${id}" and the user's words below as user_message.`,
    "</t3-replies-mode>",
    text,
  ].join("\n");
}

const CHAT_REPLIES_RULES =
  "They see only their own messages and your send_to_user messages. The main list shows first messages; a reply shows in the sub-thread under its first message. Each message from the user comes with a short id. To answer one, call send_to_user with reply_to set to its id and user_message set to its words; you may answer each message once, and only the user's latest message in a sub-thread. To change an answer, call replace_send_to_user with the same reply_to. To say something that answers no message, call send_to_user with new_sub_thread true; to change that message before the user replies under it, call replace_send_to_user with sub_thread set to the id that the send returned.";

export const CHAT_REPLIES_DISPLAY_MODE: DisplayMode = {
  id: "chat-replies",
  label: "Chat + Replies",
  notice: `<t3-display-mode>The user switched this thread to Chat + Replies. ${CHAT_REPLIES_RULES}</t3-display-mode>`,
  stateNotice: `<t3-display-mode>This thread is in Chat + Replies. ${CHAT_REPLIES_RULES}</t3-display-mode>`,
  visibleCores: foldCores,
  wrap: chatRepliesWrap,
  dashboard: false,
  oneSendPerMessage: true,
  subThreads: true,
};

export const DISPLAY_MODES: ReadonlyArray<DisplayMode> = [
  NORMAL_DISPLAY_MODE,
  MESSAGES_ONLY_DISPLAY_MODE,
  MESSAGES_DASHBOARD_DISPLAY_MODE,
  CHAT_REPLIES_DISPLAY_MODE,
];

/** An unknown or removed mode id shows the thread as Normal. */
export function resolveDisplayMode(id: string | undefined): DisplayMode {
  return DISPLAY_MODES.find((mode) => mode.id === id) ?? NORMAL_DISPLAY_MODE;
}

const USER_TYPED_SOURCES: ReadonlySet<OrchestrationV2CreationSource> = new Set(["web", "mobile"]);

/** The fields of a message that say who or what made it. */
export interface MessageOrigin {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
  readonly idleCompaction?: unknown;
}

/**
 * Returns true for a message that the user typed in a client. Messages that the server makes for the
 * user, such as a retry after a usage limit, an approval reply, or an imported message, get false,
 * and so do messages from agents, providers, scheduled tasks, and T3 Code's own `/compact`.
 */
function isUserTypedMessage(message: MessageOrigin): boolean {
  return (
    message.createdBy === "user" &&
    USER_TYPED_SOURCES.has(message.creationSource) &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined &&
    message.idleCompaction === undefined
  );
}

/**
 * Returns true for a message typed where display modes apply. Only the web app shows a mode, so the
 * agent is told about the user's screen only for these messages.
 */
export function isWebTypedMessage(message: MessageOrigin): boolean {
  return isUserTypedMessage(message) && message.creationSource === "web";
}

const ENDED_UNSENT_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);

/** The tools whose completed calls change what the user reads, and the input field with the text. */
const MESSAGE_TOOLS: Readonly<
  Record<string, { readonly type: "sent" | "rewrite"; readonly field: string }>
> = {
  [SEND_TO_USER_TOOL_NAME]: { type: "sent", field: "text" },
  [REPLACE_SEND_TO_USER_TOOL_NAME]: { type: "rewrite", field: "new_text" },
};

const pointerField = (input: object, field: string) => messagePointer(Reflect.get(input, field));

/** Whether a `send_to_user` call's input marks it as an ack. The only reader of the flag. */
export const isAckInput = (input: unknown): boolean =>
  typeof input === "object" && input !== null && Reflect.get(input, "ack") === true;

/** A call that ended without reaching the user is `other`. A call that still runs shows nothing yet. */
function messageToolEvent(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
  tool: (typeof MESSAGE_TOOLS)[string],
): DisplayEvent | null {
  // ACP providers report a refused MCP call as completed with an error result.
  const refused =
    item.status === "completed" && compactDynamicToolOutput(item.output)?.isError === true;
  if (refused || ENDED_UNSENT_STATUSES.has(item.status)) return { type: "other" };
  if (item.status !== "completed") return null;
  const input = item.input;
  if (typeof input !== "object" || input === null) return null;
  const text: unknown = Reflect.get(input, tool.field);
  if (typeof text !== "string") return null;
  const output = compactDynamicToolOutput(item.output);
  // A Normal-mode send returns `sentMessage` and ignores the other modes' fields.
  if (tool.type === "sent" && output?.sentMessage !== undefined)
    return { type: "sent", id: item.id, text };
  const replyTo = pointerField(input, "reply_to");
  return tool.type === "sent"
    ? {
        type: "sent",
        id: item.id,
        text,
        replyTo,
        pointer: messagePointer(output?.messageId),
        ...(isAckInput(input) && { ack: true as const }),
      }
    : { type: "rewrite", id: item.id, text, replyTo, subThread: pointerField(input, "sub_thread") };
}

/** The first message that a user's message replies under, from its context records. */
export function subThreadOfRecords(
  records: ReadonlyArray<unknown> | undefined,
): string | undefined {
  for (const record of records ?? []) {
    if (typeof record !== "object" || record === null) continue;
    if (Reflect.get(record, "kind") !== SUB_THREAD_RECORD_KIND) continue;
    const payload: unknown = Reflect.get(record, "payload");
    const first: unknown =
      typeof payload === "object" && payload !== null ? Reflect.get(payload, "first") : undefined;
    if (typeof first === "string" && first !== "") return first;
  }
  return undefined;
}

/**
 * A user message without `createdBy` and `creationSource`, such as the web's local copy of a message
 * that is still sending, counts as typed by the user. Blank text from any other role shows nothing.
 */
export function displayEventFromMessage(
  message: Omit<MessageOrigin, "createdBy" | "creationSource"> & {
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdBy?: MessageOrigin["createdBy"] | undefined;
    readonly creationSource?: MessageOrigin["creationSource"] | undefined;
    readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
  },
): DisplayEvent | null {
  if (message.role !== "user") return message.text.trim() === "" ? null : { type: "other" };
  return isUserTypedMessage({
    ...message,
    createdBy: message.createdBy ?? "user",
    creationSource: message.creationSource ?? "web",
  })
    ? {
        type: "user",
        id: message.id,
        text: message.text,
        under: subThreadOfRecords(message.context?.records),
      }
    : { type: "other" };
}

/** Item types that the app records but never puts in the agent's transcript. */
const OUTSIDE_TRANSCRIPT_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "checkpoint",
  "fork",
  "thread_created",
  "run_interrupt_request",
  "run_interrupt_result",
  "system_notice",
  "error",
]);

/** Items that never enter the agent's transcript, such as checkpoints and system notices, map to null. */
export function displayEventFromTurnItem(item: OrchestrationV2TurnItem): DisplayEvent | null {
  switch (item.type) {
    case "user_message":
      // A queued message that has not started is not in the agent's transcript or on the screen.
      return item.inputIntent === "queued_turn" && item.status === "pending"
        ? null
        : displayEventFromMessage({ ...item, id: item.messageId, role: "user" });
    case "assistant_message":
      return displayEventFromMessage({ id: item.messageId, role: "assistant", text: item.text });
    case "dynamic_tool": {
      const tool = MESSAGE_TOOLS[resolveT3McpToolId(item.toolName) ?? ""];
      return tool === undefined ? { type: "other" } : messageToolEvent(item, tool);
    }
    default:
      return OUTSIDE_TRANSCRIPT_TYPES.has(item.type) ? null : { type: "other" };
  }
}

/** The text of a completed `send_to_user` call. Any other item has none. */
export function sentMessageText(item: OrchestrationV2TurnItem): string | null {
  const event = displayEventFromTurnItem(item);
  return event?.type === "sent" ? event.text : null;
}

/**
 * Each completed send in `items`, by item id, with the text that the latest rewrite gave it. Only
 * tool calls decide that, so it reads no message text. With `unmatchedRewrite`, a rewrite whose
 * send lies before `items`, such as a handoff's delta, is kept by its own id: the latest one for
 * each send that the rewrites name.
 */
export function foldSentTexts(
  items: Iterable<OrchestrationV2TurnItem>,
  options: { readonly unmatchedRewrite?: boolean } = {},
): Map<string, string> {
  const events = Array.from(items)
    .filter((item) => item.type === "dynamic_tool")
    .map(displayEventFromTurnItem)
    .filter((event) => event !== null);
  const unmatched = new Map<string, { readonly id: string; readonly text: string }>();
  const texts = new Map(
    foldCores(events, (rewrite) =>
      unmatched.set(`${rewrite.replyTo ?? ""}\n${rewrite.subThread ?? ""}`, rewrite),
    ).flatMap((core): [string, string][] => (core.from === "agent" ? [[core.id, core.text]] : [])),
  );
  if (options.unmatchedRewrite) for (const { id, text } of unmatched.values()) texts.set(id, text);
  return texts;
}

/** Returns true for a `replace_send_to_user` call in any state. No screen draws one. */
export function isReplaceSendCall(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "dynamic_tool" &&
    resolveT3McpToolId(item.toolName) === REPLACE_SEND_TO_USER_TOOL_NAME
  );
}

/**
 * Returns true if the mode's screen shows this item as text. The screen draws a completed
 * `send_to_user` call as a reply in every mode, and it draws other tools as work rows.
 */
export function displayModeShowsText(modeId: string, item: OrchestrationV2TurnItem): boolean {
  const event = displayEventFromTurnItem(item);
  if (item.type === "dynamic_tool" && event?.type !== "sent") return false;
  const { visibleCores } = resolveDisplayMode(modeId);
  return visibleCores === null || (event !== null && visibleCores([event]).length > 0);
}
