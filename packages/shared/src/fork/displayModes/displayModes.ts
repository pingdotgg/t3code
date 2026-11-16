import {
  isCompactionCommandMessage,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2TurnItem,
  type ServerSettings,
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
      /** A `/compact` with no attachments: it only compacts, so it owes no answer. */
      readonly compaction?: true;
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

/**
 * Whether `event` is a user message in the main list (not a `/compact`), or a send that answers none.
 * An answer's place needs the message it answers, so only these events are in the main list on their
 * own.
 */
export const isMainListOnItsOwn = (event: DisplayEvent): boolean =>
  (event.type === "user" && event.under === undefined && event.compaction !== true) ||
  (event.type === "sent" && event.replyTo === undefined);

/** A core is one message that a display mode shows, from the user or from the agent. */
export interface VisibleCore {
  readonly id: string;
  readonly from: "user" | "agent";
  readonly text: string;
  /**
   * The id of the main-list message whose sub-thread holds the core: its own id for a core in the
   * main list, and null for an answer to a user message that is not among the events.
   * Invariant: `!reply` implies `first === id`.
   */
  readonly first: string | null;
  /**
   * Whether the core is not in the main list: it shows in the sub-thread of `first`, or nowhere when
   * `first` is null. A user message is a reply when it carries a `fork-reply` record. An answer is a
   * reply when the message it answers is one.
   */
  readonly reply: boolean;
  /**
   * The id that the agent names the core by: for a user message, a hash of its id; for the agent's
   * message that answers none, the id that its send returned, which the stored call keeps, or a
   * hash of the text it was sent with when the send returned none. An agent's answer has none: the
   * agent names it by the message it answers.
   */
  readonly shortId?: string | undefined;
  /** For an agent's answer, the short id of the user message that it answers. */
  readonly replyTo?: string | undefined;
  /** An ack that no rewrite has made the answer yet. */
  readonly ack?: true;
  /** A user's `/compact` with no attachments, which owes no answer. */
  readonly compaction?: true;
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
  /**
   * What the server records once the agent has this mode's rules. A change to the rules gives the
   * mode a new value, so a thread told an older one gets `stateNotice` again.
   */
  readonly toldId: string;
  readonly label: string;
  /**
   * Goes before the first message that the user types after the thread switches to this mode. A new
   * thread starts as Normal, so its first message in another mode gets that mode's note.
   */
  readonly notice: string;
  /** States the mode to an agent whose conversation was just compacted, which may have dropped `notice`. */
  readonly stateNotice: string;
  /**
   * Returns the text that the agent gets for the user's `message` after `events`. Null sends it
   * unchanged. `events` may leave out events, as long as it keeps their order, the first message of
   * the message's sub-thread, the latest WRAPPED_CORE_COUNT `user` and `sent` events in that
   * sub-thread, and every `rewrite` after the first of those.
   */
  readonly wrap:
    | ((events: ReadonlyArray<DisplayEvent>, text: string, message: WrappedMessage) => string)
    | null;
  /**
   * Whether the user can reply under one of the agent's main-list messages, in its sub-thread. The
   * main list shows the cores that are not replies. The agent answers each message that the user
   * types once, by its short id, after at most one ack, and the answer shows where that message is.
   * To say more, it rewrites that answer with `replace_send_to_user`.
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
  const unplacedAnswers = new Map<string, number>();
  for (const event of events) {
    switch (event.type) {
      case "user": {
        // Reply shows only on main-list rows, so a reply under an unplaced answer places it there.
        const root = event.under === undefined ? undefined : unplacedAnswers.get(event.under);
        if (root !== undefined)
          cores[root] = { ...cores[root]!, first: event.under!, reply: false };
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
            ...(event.compaction && { compaction: event.compaction }),
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
          const question = answered === undefined ? undefined : cores[answered]!;
          // An answer shows where the message it answers is. With that message not among the
          // events, its place is unknown and it shows nowhere until a reply under it places it;
          // ShownHistory loads that message with it.
          const inMainList = question !== undefined && !question.reply;
          latestSent =
            cores.push({
              id: event.id,
              from: "agent",
              text: event.text,
              first: question === undefined ? null : inMainList ? event.id : question.first,
              reply: !inMainList,
              replyTo: event.replyTo,
              ...(event.ack && { ack: event.ack }),
            }) - 1;
          answerByReplyTo.set(event.replyTo, latestSent);
          if (question === undefined) unplacedAnswers.set(event.id, latestSent);
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

/** Whether `a` and `b` show in the same place: both in the main list, or both in one sub-thread. */
export const samePlace = (a: VisibleCore, b: VisibleCore): boolean =>
  a.reply === b.reply && (!a.reply || (a.first !== null && a.first === b.first));

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
  toldId: "normal",
  label: "Normal mode",
  notice:
    "<t3-display-mode>The user switched this thread back to the full view. They see your replies and tool calls again; reply as usual, not only through send_to_user.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in the full view. The user sees your replies and tool calls; reply as usual, not only through send_to_user.</t3-display-mode>",
  wrap: null,
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
      ? `Message "${id}" from the user in the main list.`
      : shown.length === 0
        ? `Message "${id}" from the user, a reply in a sub-thread.`
        : `Message "${id}" from the user, a reply in the sub-thread that showed:`,
    ...shown.map(recapLine),
    `To answer, call send_to_user with reply_to "${id}" and the user's words below as user_message. Your answer shows ${message.under === undefined ? "in the main list" : "in this sub-thread"}.`,
    "</t3-replies-mode>",
    text,
  ].join("\n");
}

const CHAT_REPLIES_RULES =
  "They see only their own messages and your send_to_user messages. The main list is one chat. The user can also choose Reply on one of your messages there and talk with you in its sub-thread. Each message from the user comes with a short id. To answer one, call send_to_user with reply_to set to its id and user_message set to its words; your answer shows where the user wrote it, in the main list or in that sub-thread. Answer only the user's latest message in each place, once. To change an answer, call replace_send_to_user with the same reply_to, until the user writes after it there or replies under it. To say something that answers no message, call send_to_user with new_sub_thread true: it shows in the main list, one until the user writes there again. To change that message, call replace_send_to_user with sub_thread set to the id that the send returned, until the user writes after it or replies under it.";

export const CHAT_REPLIES_DISPLAY_MODE: DisplayMode = {
  id: "chat-replies",
  toldId: "chat-replies@3",
  label: "Chat mode",
  notice: `<t3-display-mode>The user switched this thread to Chat mode. ${CHAT_REPLIES_RULES}</t3-display-mode>`,
  stateNotice: `<t3-display-mode>This thread is in Chat mode. ${CHAT_REPLIES_RULES}</t3-display-mode>`,
  wrap: chatRepliesWrap,
  subThreads: true,
};

export const DISPLAY_MODES: ReadonlyArray<DisplayMode> = [
  NORMAL_DISPLAY_MODE,
  CHAT_REPLIES_DISPLAY_MODE,
];

/** An unknown or removed mode id shows the thread as Normal. */
export function resolveDisplayMode(id: string | undefined): DisplayMode {
  return DISPLAY_MODES.find((mode) => mode.id === id) ?? NORMAL_DISPLAY_MODE;
}

/** What a thread's screen shows. The Dashboard is on or off in any mode. */
export interface ThreadDisplay {
  readonly mode: DisplayMode;
  readonly dashboard: boolean;
}

export const NORMAL_DISPLAY: ThreadDisplay = { mode: NORMAL_DISPLAY_MODE, dashboard: false };

/** What the server records once the agent knows `display`: the mode's `toldId`, then `+dashboard` when on. */
export function toldKey(display: ThreadDisplay): string {
  return display.dashboard ? `${display.mode.toldId}+dashboard` : display.mode.toldId;
}

/** Every display by its told key, so equal displays are one object and keep React identities stable. */
const DISPLAYS: ReadonlyMap<string, ThreadDisplay> = new Map(
  DISPLAY_MODES.flatMap((mode) =>
    [false, true].map((dashboard) => {
      const display =
        mode === NORMAL_DISPLAY_MODE && !dashboard ? NORMAL_DISPLAY : { mode, dashboard };
      return [toldKey(display), display] as const;
    }),
  ),
);

/** No settings, an unknown mode id, and a Dashboard entry other than `true` read as Normal and off. */
export function threadDisplay(
  settings: Pick<ServerSettings, "threadDisplayModes" | "threadDashboards"> | null | undefined,
  threadId: string,
): ThreadDisplay {
  const mode = resolveDisplayMode(settings?.threadDisplayModes[threadId]);
  const dashboard = settings?.threadDashboards[threadId] === true;
  return DISPLAYS.get(toldKey({ mode, dashboard })) ?? NORMAL_DISPLAY;
}

const DASHBOARD_RULES =
  "They see this thread's Dashboard beside the chat, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.";
const DASHBOARD_ON_NOTICE = `<t3-display-mode>The user turned on this thread's Dashboard. ${DASHBOARD_RULES}</t3-display-mode>`;
const DASHBOARD_OFF_NOTICE =
  "<t3-display-mode>The user turned off this thread's Dashboard. They no longer see it, and dashboard_get and dashboard_set are refused.</t3-display-mode>";
const DASHBOARD_ON_STATE_NOTICE = `<t3-display-mode>This thread's Dashboard is on. ${DASHBOARD_RULES}</t3-display-mode>`;
const DASHBOARD_OFF_STATE_NOTICE =
  "<t3-display-mode>This thread's Dashboard is off. The user does not see it, and dashboard_get and dashboard_set are refused.</t3-display-mode>";

/** All of `display`, for an agent that may have lost its notes. An off Dashboard adds nothing. */
export function displayStateNote(display: ThreadDisplay): string {
  return display.dashboard
    ? `${display.mode.stateNotice}\n${DASHBOARD_ON_STATE_NOTICE}`
    : display.mode.stateNotice;
}

/**
 * The note that brings an agent told `told` up to `display`, or null when it knows it. It compares
 * what the agent knows with now, so a change undone before the next message needs no note. A told
 * value that names no display, such as `unknown` or an older rules version, gets the whole state.
 */
export function displayNote(told: string, display: ThreadDisplay): string | null {
  if (told === toldKey(display)) return null;
  const known = DISPLAYS.get(told);
  if (known === undefined)
    return display.dashboard
      ? displayStateNote(display)
      : `${display.mode.stateNotice}\n${DASHBOARD_OFF_STATE_NOTICE}`;
  return [
    ...(known.mode === display.mode ? [] : [display.mode.notice]),
    ...(known.dashboard === display.dashboard
      ? []
      : [display.dashboard ? DASHBOARD_ON_NOTICE : DASHBOARD_OFF_NOTICE]),
  ].join("\n");
}

/** Each removed mode id, with the mode that replaces it and whether its Dashboard stays on. */
const REMOVED_DISPLAY_MODES: ReadonlyMap<
  string,
  { readonly id: string; readonly dashboard: boolean }
> = new Map([
  ["messages-only", { id: CHAT_REPLIES_DISPLAY_MODE.id, dashboard: false }],
  ["messages-dashboard", { id: CHAT_REPLIES_DISPLAY_MODE.id, dashboard: true }],
]);

/**
 * `settings` with each removed mode id replaced, or `settings` itself when it holds none. The
 * server runs it on each read and write of its settings, so other readers know only current ids.
 */
export function withoutRemovedDisplayModes<
  S extends Pick<
    ServerSettings,
    "threadDisplayModes" | "threadDashboards" | "newThreadDisplayMode"
  >,
>(settings: S): S {
  const removed = Object.entries(settings.threadDisplayModes).flatMap(([threadId, id]) => {
    const replacement = REMOVED_DISPLAY_MODES.get(id);
    return replacement === undefined ? [] : [[threadId, replacement] as const];
  });
  const newThreadMode = REMOVED_DISPLAY_MODES.get(settings.newThreadDisplayMode);
  if (removed.length === 0 && newThreadMode === undefined) return settings;
  const threadDisplayModes = { ...settings.threadDisplayModes };
  const threadDashboards = { ...settings.threadDashboards };
  for (const [threadId, replacement] of removed) {
    threadDisplayModes[threadId] = replacement.id;
    // Only an older client writes a removed id now, and its Messages only means no Dashboard.
    if (replacement.dashboard) threadDashboards[threadId] = true;
    else delete threadDashboards[threadId];
  }
  return {
    ...settings,
    threadDisplayModes,
    threadDashboards,
    newThreadDisplayMode: newThreadMode?.id ?? settings.newThreadDisplayMode,
  };
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
    readonly attachments?: ReadonlyArray<unknown> | undefined;
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
        ...(isCompactionCommandMessage({
          role: "user",
          text: message.text,
          attachments: message.attachments,
        }) && {
          compaction: true as const,
        }),
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
  return (
    !resolveDisplayMode(modeId).subThreads || (event !== null && foldCores([event]).length > 0)
  );
}
