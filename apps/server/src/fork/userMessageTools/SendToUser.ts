import {
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import {
  ACK_MAX_BYTES,
  displayEventFromTurnItem,
  foldCores,
  freshFirstPointer,
  isMainListOnItsOwn,
  messagePointer,
  recapLine,
  recapText,
  REPLACE_SEND_TO_USER_TOOL_NAME,
  resolveDisplayMode,
  samePlace,
  SEND_TO_USER_MAX_BYTES,
  SEND_TO_USER_TOOL_NAME,
  SUB_THREAD_LISTED_COUNT,
  SUB_THREAD_WINDOW_CORES,
  subThreadCores,
  subThreadRecap,
  type VisibleCore,
  WRAPPED_CORE_COUNT,
} from "@t3tools/shared/displayModes";
import { TEXT_MATCH_MIN_RATIO, textSimilarity } from "@t3tools/shared/textMatch";
import { SEND_TO_USER_MAX_LENGTH } from "@t3tools/shared/toolOutput";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DisplayModeWrap } from "../displayModeWrap/DisplayModeWrap.ts";
import * as SubThreads from "../subThreads/SubThreads.ts";
import {
  judgeReplace,
  judgeSend,
  makeReplyHolds,
  type ReplyCall,
  replyCallOf,
} from "./replyStage.ts";

const MAX_BYTES_TEXT = `Markdown, at most ${SEND_TO_USER_MAX_BYTES} bytes of UTF-8 after JSON escaping; a longer text is refused and not shown. Most CJK characters count as 3 bytes, a quote, a backslash, a tab, or a line break as 2, and most other control characters as 6.`;
// The description goes before the checks: one set after a custom check is left out of the JSON schema.
const messageText = (description: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(1));
const MessageText = messageText(MAX_BYTES_TEXT);
// Normal mode takes upstream's send_to_user limit; the other modes keep the fork's.
const SendText = messageText(
  `In a thread set to Messages only, Messages + Dashboard or Chat + Replies: ${MAX_BYTES_TEXT} In any other thread (the full view, Normal): at most ${SEND_TO_USER_MAX_LENGTH} UTF-16 code units, where most characters count once and an emoji or a rare CJK character twice or more.`,
);

const jsonEscapedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;

// Each MessageText field goes through this in its handler; a schema failure loses the exact text.
const checkMessageSize = (text: string, ack = false) =>
  jsonEscapedBytes(text) <= (ack ? ACK_MAX_BYTES : SEND_TO_USER_MAX_BYTES)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: ack
            ? `an ack is at most ${ACK_MAX_BYTES} bytes. Say only that you got the message and are on it.`
            : "only say one concise point at a time",
        }),
      );

// Agents are told 2000 bytes and a little over still passes; 2500 + 2500 + SEND_TO_USER_MAX_BYTES
// keeps a replace call's input under the 16 KiB a tool input may take on the wire.
const MATCH_INPUT_TOLD_BYTES = 2000;
const MATCH_INPUT_MAX_BYTES = 2500;

const MatchInput = (description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.makeFilter((text: string) =>
      jsonEscapedBytes(text) <= MATCH_INPUT_MAX_BYTES
        ? true
        : `Over ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8 once JSON-escaped. Pass the text as the recap shows it.`,
    ),
  );

/** How long an accepted send counts while its call is not yet in the history, for calls not named. */
const UNNAMED_SEND_HOLD_MS = 10_000;
const MIN_PERCENT = Math.round(TEXT_MATCH_MIN_RATIO * 100);
const DONE = "If you are done, end your turn with no text.";
const SHOWN = { ok: true as const, message: `Shown to the user. ${DONE}` };
const SHOWN_NORMAL = { ok: true as const, message: "Shown to the user. Don't repeat it." };
const ACKED = {
  ok: true as const,
  message: "Shown to the user as an ack. Send your answer when it is ready.",
};
const LAST_MESSAGE = { what: "the user's last message", replace: REPLACE_SEND_TO_USER_TOOL_NAME };

// An agent that fills every optional field sends null, an empty string or false for "none".
const Pointer = (description: string) =>
  Schema.optional(Schema.NullOr(Schema.String.annotate({ description })));

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettings.ServerSettingsService,
  DisplayModeWrap,
];

// The tools change only what the caller's thread shows, so read-only sandboxes and plan mode may use them.
const SendToUserTool = Tool.make(SEND_TO_USER_TOOL_NAME, {
  description:
    "Show the user a message in this thread. In a thread set to Messages only, this is the only output the user sees. In a thread set to Chat + Replies, also pass reply_to with user_message, or new_sub_thread. In the full view (Normal), use it for content the user must read in full before your turn ends, such as a draft or a code block, and don't repeat it in your reply.",
  parameters: Schema.Struct({
    text: SendText,
    reply_to: Pointer(
      "Chat + Replies only. The id of the user's message that this text answers, as the <t3-replies-mode> block before that message gave it. The answer shows where that message is: in the main list or in its sub-thread.",
    ),
    user_message: Schema.optional(
      Schema.NullOr(
        MatchInput(
          `Needed with reply_to. The words of the user's message that you answer, or their first ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8. They must be at least ${MIN_PERCENT}% like that message.`,
        ),
      ),
    ),
    new_sub_thread: Schema.optional(
      Schema.NullOr(
        Schema.Boolean.annotate({
          description:
            "Chat + Replies only. True for a message that answers no message from the user. It shows in the main list, where the user can reply under it: one until the user writes there again.",
        }),
      ),
    ),
    ack: Schema.optional(
      Schema.NullOr(
        Schema.Boolean.annotate({
          description: `In a thread set to Messages only, Messages + Dashboard or Chat + Replies: true for a note of at most ${ACK_MAX_BYTES} bytes that you got the message and are on it, only when your answer will take a while. At most one, before the answer.`,
        }),
      ),
    ),
  }),
  success: Schema.Struct({
    ok: Schema.Literal(true),
    message: Schema.String,
    messageId: Schema.optional(Schema.String),
    // Normal mode only: web and mobile draw this as the agent's words, as upstream's send_to_user.
    sentMessage: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Send to user")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Claude is told to use it from its first turn; Claude Code otherwise defers it behind ToolSearch.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

const ReplaceSendToUserTool = Tool.make(REPLACE_SEND_TO_USER_TOOL_NAME, {
  description: `In threads set to Messages only, Messages + Dashboard or Chat + Replies, you answer each message of the user once, after at most one ack. This replaces your latest message for it in place; an ack becomes the answer. Pass the user's last message and your current message as the recap shows them (their words only), each at least ${MIN_PERCENT}% alike, and the whole new text. In Chat + Replies, also pass reply_to or sub_thread.`,
  parameters: Schema.Struct({
    reply_to: Pointer(
      "Chat + Replies only. The id of the user's message whose answer you replace, until the user writes after that answer or replies under it. user_message is then that message.",
    ),
    sub_thread: Pointer(
      "Chat + Replies only. The id of a message that you sent with new_sub_thread, as that send returned it, to replace that message until the user writes after it or replies under it. user_message is then an empty string.",
    ),
    user_message: MatchInput(
      `The user's last message, at most ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8 after JSON escaping. An empty string if they have typed none.`,
    ),
    old_text: MatchInput(
      `Your current message to the user, at most ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8 after JSON escaping.`,
    ),
    new_text: MessageText,
  }),
  success: Schema.Struct({ ok: Schema.Literal(true), message: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Rewrite a message to the user")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SendToUserToolkit = Toolkit.make(SendToUserTool, ReplaceSendToUserTool);

/** The items stored before the calling tool use, when the provider names it; else all of them. */
function itemsBefore(shown: ReadonlyArray<OrchestrationV2TurnItem>, ownItem: string | undefined) {
  const ownAt =
    ownItem === undefined
      ? -1
      : shown.findIndex((item) => item.nativeItemRef?.nativeId === ownItem);
  return ownAt < 0 ? shown : shown.slice(0, ownAt);
}

const coresOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  foldCores(
    items.flatMap((item) => {
      const event = displayEventFromTurnItem(item);
      return event === null ? [] : [event];
    }),
  );

/** The calls toward the answer to the user message at `at`: those after it that `concerns` keeps. */
function replyCallsAfter(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  at: number,
  named: boolean,
  concerns: (item: OrchestrationV2TurnItem) => boolean = () => true,
): ReadonlyArray<ReplyCall> {
  return items.slice(at + 1).flatMap((item) => {
    const call = concerns(item) ? replyCallOf(item, named) : null;
    return call === null ? [] : [call];
  });
}

/**
 * What the thread shows since the user's last typed message. `ownItem` is the native id of the
 * calling tool use when the provider names it; only then do sends still running count, and only
 * items stored before the call's own, so of two sends in one response the first is shown, and a
 * message typed after the call started does not change the answer.
 */
function readTurn(shown: ReadonlyArray<OrchestrationV2TurnItem>, ownItem: string | undefined) {
  const items = itemsBefore(shown, ownItem);
  const cores = coresOf(items);
  const typedAt = cores.findLastIndex((core) => core.from === "user");
  return {
    latest: cores.slice(-WRAPPED_CORE_COUNT),
    typed: typedAt < 0 ? undefined : cores[typedAt],
    current: cores.slice(typedAt + 1).findLast((core) => core.from === "agent"),
    calls: replyCallsAfter(
      items,
      items.findLastIndex((item) => displayEventFromTurnItem(item)?.type === "user"),
      ownItem !== undefined,
    ),
  };
}

type Turn = ReturnType<typeof readTurn>;

const refusal = (
  code: OrchestratorMcpFailure["code"],
  reasons: ReadonlyArray<string>,
  turn: Turn,
) =>
  new OrchestratorMcpFailure({
    code,
    message: [
      `Refused: ${reasons.join(" ")}`,
      ...(turn.latest.length === 0
        ? []
        : ["Latest messages between you and the user:", ...turn.latest.map(recapLine)]),
      ...(turn.current === undefined
        ? []
        : ["Your current message, as old_text:", recapText(turn.current.text)]),
    ].join("\n"),
  });

/** A text the agent copied from a recap line, compared without the line's marks. */
const quoted = (text: string) =>
  recapText(text.replace(/^\[(?:user|you)\] /, "").replace(/…\[truncated\]$/, ""));

/** The user's message as the agent got it: each quote as a placeholder, with no citation block. */
function providerForm(text: string): string {
  const expanded = expandAssistantCitationsForProvider(text);
  return recapText(
    expanded === text ? text : expanded.slice(0, expanded.lastIndexOf("\n\n<assistant_citations>")),
  );
}

const percent = (similarity: number) => Math.floor(similarity * 100);

/** How alike `given` is to the user's message `typed`, in the recap's form or the form the agent got. */
const userSimilarity = (given: string, typed: string) =>
  Math.max(
    textSimilarity(quoted(given), recapText(typed)),
    textSimilarity(quoted(given), providerForm(typed)),
  );

const userMismatch = (similarity: number, what: string, typed: string) =>
  `user_message is ${percent(similarity)}% like ${what}; ${typed === "" ? "expected an empty string" : `needs ${MIN_PERCENT}%`}.`;

/** One line of a list of messages that the agent can name: the id, then the start of the text. */
const listedLine = (core: VisibleCore) => {
  const line = recapText(core.text).split("\n", 1)[0] ?? "";
  return `"${core.shortId}": ${line.length > 160 ? `${line.slice(0, 160)}…` : line}`;
};

/** A user's message that owes an answer: not a `/compact`, which runs with no turn of the agent. */
const owesAnswer = (core: VisibleCore) => core.from === "user" && core.compaction !== true;

/** The user's messages that the agent may still answer: the latest of its place, with no answer. */
function unansweredLines(cores: ReadonlyArray<VisibleCore>): ReadonlyArray<string> {
  const open = cores.filter(
    (core, index) =>
      owesAnswer(core) &&
      // After the message: an earlier message may have the same short id, with an answer of its own.
      !cores.slice(index + 1).some((answer) => answer.replyTo === core.shortId && !answer.ack) &&
      !cores.slice(index + 1).some((later) => owesAnswer(later) && samePlace(later, core)),
  );
  return open.length === 0
    ? []
    : [
        "Messages from the user with no answer yet, by id:",
        ...open.slice(-SUB_THREAD_LISTED_COUNT).map(listedLine),
      ];
}

/** The user's latest message after `message`, in its place or under it. It freezes `message`. */
function userAfter(
  cores: ReadonlyArray<VisibleCore>,
  message: VisibleCore,
): VisibleCore | undefined {
  return cores
    .slice(cores.findIndex((core) => core.id === message.id) + 1)
    .findLast(
      (core) => owesAnswer(core) && (samePlace(core, message) || core.first === message.id),
    );
}

/** Whether `core` is a message that the agent sent with `new_sub_thread`. */
const isNewMessage = (core: VisibleCore) =>
  core.from === "agent" && !core.reply && core.replyTo === undefined;

/** The agent's messages sent with `new_sub_thread` that it may still replace. */
function replaceableLines(cores: ReadonlyArray<VisibleCore>): ReadonlyArray<string> {
  const open = cores.filter((core) => isNewMessage(core) && userAfter(cores, core) === undefined);
  return open.length === 0
    ? []
    : [
        "Your messages sent with new_sub_thread that you may still change, by id:",
        ...open.slice(-SUB_THREAD_LISTED_COUNT).map(listedLine),
      ];
}

/** A refusal that shows what the user saw where `at` is: the main list, or its sub-thread. */
const placeRefusal = (
  code: OrchestratorMcpFailure["code"],
  reasons: ReadonlyArray<string>,
  cores: ReadonlyArray<VisibleCore>,
  at: VisibleCore | undefined,
  more: ReadonlyArray<string>,
) => {
  const shown =
    at === undefined
      ? []
      : !at.reply
        ? cores.filter((core) => !core.reply).slice(-WRAPPED_CORE_COUNT)
        : at.first === null
          ? []
          : subThreadRecap(subThreadCores(cores, at.first));
  return new OrchestratorMcpFailure({
    code,
    message: [
      `Refused: ${reasons.join(" ")}`,
      ...(shown.length === 0
        ? []
        : [
            at?.reply ? "That message's sub-thread shows:" : "The main list shows:",
            ...shown.map(recapLine),
          ]),
      ...more,
    ].join("\n"),
  });
};

const CHECK_MESSAGE = "Check that this is the message you mean to answer.";
const inputField = (item: OrchestrationV2TurnItem, field: string): unknown =>
  item.type === "dynamic_tool" && typeof item.input === "object" && item.input !== null
    ? Reflect.get(item.input, field)
    : undefined;

/** The calls toward the answer to the user message `target` that name it by `replyTo`. */
function answerCalls(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  target: string,
  replyTo: string,
  named: boolean,
) {
  // After the message: an earlier message may have the same short id, with an answer of its own.
  const targetAt = items.findIndex(
    (item) => item.type === "user_message" && item.messageId === target,
  );
  return replyCallsAfter(items, targetAt, named, (item) => {
    // A completed send counts where it shows; a Normal-mode send answers no message.
    const event = displayEventFromTurnItem(item);
    const pointer =
      event?.type === "sent" || event?.type === "rewrite"
        ? event.replyTo
        : messagePointer(inputField(item, "reply_to"));
    return pointer === replyTo;
  });
}

/** Whether a send still running would be shown as a new message: the handler would accept it. */
function takenAsNewMessage(item: OrchestrationV2TurnItem) {
  const text = inputField(item, "text");
  return (
    inputField(item, "new_sub_thread") === true &&
    inputField(item, "ack") !== true &&
    messagePointer(inputField(item, "reply_to")) === undefined &&
    typeof text === "string" &&
    text !== "" &&
    jsonEscapedBytes(text) <= SEND_TO_USER_MAX_BYTES
  );
}

/**
 * The agent's messages in the main list since the user's latest message there: delivered ones, and
 * with `named`, sends still running that the handler would take as a new message.
 */
function mainListSends(items: ReadonlyArray<OrchestrationV2TurnItem>, named: boolean) {
  const at = items.findLastIndex((item) => {
    const event = displayEventFromTurnItem(item);
    return event?.type === "user" && isMainListOnItsOwn(event);
  });
  return {
    anchor: items[at]?.id,
    sends: replyCallsAfter(items, at, named, (item) => {
      const event = displayEventFromTurnItem(item);
      return event === null
        ? takenAsNewMessage(item)
        : event.type === "sent" && isMainListOnItsOwn(event);
    }),
  };
}

/** After a refused new message: how to change the agent's message in the main list, and what to answer. */
function mainListTakenLines(cores: ReadonlyArray<VisibleCore>): ReadonlyArray<string> {
  const since = cores
    .slice(cores.findLastIndex((core) => owesAnswer(core) && !core.reply) + 1)
    .filter(isNewMessage);
  const open = since.filter((core) => userAfter(cores, core) === undefined);
  return [
    ...(since.length === 0
      ? [
          "That message is still being delivered. To change it once it shows, call replace_send_to_user with sub_thread set to the id that its send returned.",
        ]
      : open.length === 0
        ? ["The user has replied under it, so it stays as it is."]
        : [
            "To change it, call replace_send_to_user with sub_thread set to its id:",
            ...open.map(listedLine),
          ]),
    ...unansweredLines(cores.slice(-SUB_THREAD_WINDOW_CORES)),
    DONE,
  ];
}

const orchestrationError = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

export const layerHandlers = McpToolAccess.toLayer(
  SendToUserToolkit,
  Effect.gen(function* () {
    const subThreads = yield* SubThreads.orIdle;
    // Both tools decide on the thread's history, so calls of one thread take turns.
    const locks = new Map<ThreadId, Semaphore.Semaphore>();
    const lockFor = (threadId: ThreadId) => {
      let lock = locks.get(threadId);
      if (lock === undefined) locks.set(threadId, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };

    const callerThread = Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(orchestrationError),
      );
      return {
        threadId: thread.threadId,
        mode: resolveDisplayMode(settings.threadDisplayModes[thread.threadId]),
      };
    });

    // Claude Code names the tool use in the call's _meta, and a Claude item's native id is that id.
    const readThreadTurn = Effect.fn("SendToUser.readThreadTurn")(function* (threadId: ThreadId) {
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      const named = Option.getOrUndefined(client)?.requestMetadata?.["claudecode/toolUseId"];
      const toolUseId = typeof named === "string" ? named : undefined;
      const items = yield* (yield* DisplayModeWrap)
        .latestShownItems(threadId, toolUseId)
        .pipe(Effect.mapError(orchestrationError));
      return { ...readTurn(items, toolUseId), named: toolUseId !== undefined };
    });

    // A call that does not name itself cannot tell a send still running from its own, so two such
    // sends in one response would both pass. The stage that an accepted call reached counts for a
    // few seconds instead, while the provider has not yet stored it, for that user message only.
    /** The ids given to first messages that may not be in the history yet, each with its hold's end. */
    const givenIds = new Map<string, number>();
    const holds = makeReplyHolds(UNNAMED_SEND_HOLD_MS);
    const holdKey = (threadId: ThreadId, userMessage: string | undefined) =>
      `${threadId}\n${userMessage ?? ""}`;

    const readThreadCores = Effect.fn("SendToUser.readThreadCores")(function* (
      threadId: ThreadId,
      toMainListMessage: boolean,
    ) {
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      const named = Option.getOrUndefined(client)?.requestMetadata?.["claudecode/toolUseId"];
      const toolUseId = typeof named === "string" ? named : undefined;
      const shown = yield* (yield* DisplayModeWrap)
        .latestShownItems(threadId, toolUseId, SUB_THREAD_WINDOW_CORES, toMainListMessage)
        .pipe(Effect.mapError(orchestrationError));
      const items = itemsBefore(shown, toolUseId);
      // `cores` is what the agent saw when it made the call. `coresNow` has what the user typed since.
      return {
        items,
        cores: coresOf(items),
        coresNow: coresOf(shown),
        named: toolUseId !== undefined,
      };
    });

    const subThreadChanged = (
      threadId: ThreadId,
      thread: ReadonlyArray<VisibleCore>,
      first: string,
    ) => subThreads.changed({ threadId, firstId: first, thread });

    const sendInSubThread = Effect.fn("SendToUser.sendInSubThread")(function* (
      threadId: ThreadId,
      input: {
        readonly text: string;
        readonly reply_to?: string | null | undefined;
        readonly user_message?: string | null | undefined;
        readonly new_sub_thread?: boolean | null | undefined;
        readonly ack?: boolean | null | undefined;
      },
    ) {
      const replyTo = messagePointer(input.reply_to);
      const { items, cores, named } = yield* readThreadCores(
        threadId,
        replyTo === undefined && input.new_sub_thread === true && input.ack !== true,
      );
      if ((replyTo !== undefined) === (input.new_sub_thread === true)) {
        return yield* placeRefusal(
          "invalid_request",
          [
            "this thread is set to Chat + Replies. To answer a message from the user, pass reply_to with its id and user_message with its words. For a message that answers none, pass new_sub_thread true and no reply_to.",
          ],
          cores,
          undefined,
          unansweredLines(cores),
        );
      }
      if (replyTo === undefined && input.ack === true) {
        return yield* placeRefusal(
          "invalid_request",
          [
            "an ack answers a message from the user, so it needs reply_to. Send a new message without ack.",
          ],
          cores,
          undefined,
          unansweredLines(cores),
        );
      }
      if (replyTo === undefined) {
        const now = yield* Clock.currentTimeMillis;
        const main = mainListSends(items, named);
        const mainKey = holdKey(threadId, `main\n${main.anchor ?? ""}`);
        if (main.sends.length > 0 || holds.held(mainKey, named, now) !== "open") {
          return yield* placeRefusal(
            "invalid_request",
            [
              "you already sent a new message to the main list, and the user has not written there since. You may not send two in a row there.",
            ],
            cores,
            undefined,
            mainListTakenLines(cores),
          );
        }
        holds.record(mainKey, named, "answer", "answered", now);
        // A user message to the main list between two first messages can come before the first is
        // in the history, so the ids given for a while count as taken.
        for (const [id, until] of givenIds) if (until <= now) givenIds.delete(id);
        const id = freshFirstPointer(
          new Set([
            ...cores.map((core) => core.shortId),
            ...[...givenIds.keys()].flatMap((given) =>
              given.startsWith(`${threadId}\n`) ? [given.slice(threadId.length + 1)] : [],
            ),
          ]),
          input.text,
        );
        givenIds.set(`${threadId}\n${id}`, now + UNNAMED_SEND_HOLD_MS);
        return {
          ok: true as const,
          message: `Shown to the user as a new message with the id "${id}". ${DONE}`,
          // The stored call keeps the id, and every later fold reads it from there.
          messageId: id,
        };
      }
      const target = cores.findLast((core) => core.from === "user" && core.shortId === replyTo);
      if (target === undefined) {
        return yield* placeRefusal(
          "invalid_request",
          [`no message from the user has the id "${replyTo}".`],
          cores,
          undefined,
          unansweredLines(cores),
        );
      }
      const similarity = userSimilarity(input.user_message ?? "", target.text);
      if (similarity < TEXT_MATCH_MIN_RATIO) {
        return yield* placeRefusal(
          "invalid_request",
          [userMismatch(similarity, `message "${replyTo}"`, target.text)],
          cores,
          target,
          [CHECK_MESSAGE],
        );
      }
      // `/compact` is never the latest message, except when it is the one being answered.
      const counts = owesAnswer(target) ? owesAnswer : (core: VisibleCore) => core.from === "user";
      const latest = cores.findLast((core) => counts(core) && samePlace(core, target));
      if (latest !== target) {
        return yield* placeRefusal(
          "invalid_request",
          [
            `the user sent a later message, "${latest?.shortId}", ${target.reply ? "in this sub-thread" : "in the main list"}. Answer that one.`,
          ],
          cores,
          target,
          [],
        );
      }
      const now = yield* Clock.currentTimeMillis;
      const key = holdKey(threadId, target.id);
      const verdict = judgeSend({
        calls: answerCalls(items, target.id, replyTo, named),
        held: holds.held(key, named, now),
        kind: input.ack === true ? "ack" : "answer",
        subject: {
          what: `message "${replyTo}"`,
          replace: `${REPLACE_SEND_TO_USER_TOOL_NAME} with reply_to "${replyTo}"`,
        },
      });
      if (!verdict.ok)
        return yield* placeRefusal("invalid_request", [verdict.reason], cores, target, []);
      holds.record(key, named, input.ack === true ? "ack" : "answer", verdict.next, now);
      if (input.ack === true) return ACKED;
      if (target.reply && target.first !== null)
        yield* subThreadChanged(
          threadId,
          [
            ...subThreadCores(cores, target.first),
            { id: "", from: "agent", text: input.text, first: target.first, reply: true },
          ],
          target.first,
        );
      return {
        ok: true as const,
        message: `Shown to the user as your answer to "${replyTo}", ${target.reply ? "in its sub-thread" : "in the main list"}. ${DONE}`,
      };
    });

    const replaceInSubThread = Effect.fn("SendToUser.replaceInSubThread")(function* (
      threadId: ThreadId,
      input: {
        readonly reply_to?: string | null | undefined;
        readonly sub_thread?: string | null | undefined;
        readonly user_message: string;
        readonly old_text: string;
        readonly new_text: string;
      },
    ) {
      const { items, cores, coresNow, named } = yield* readThreadCores(threadId, false);
      const replyTo = messagePointer(input.reply_to);
      const subThread = messagePointer(input.sub_thread);
      if ((replyTo === undefined) === (subThread === undefined)) {
        return yield* placeRefusal(
          "invalid_request",
          [
            "this thread is set to Chat + Replies. Pass reply_to to replace your answer to that message from the user, or sub_thread to replace a message that you sent with new_sub_thread, and not both.",
          ],
          cores,
          undefined,
          [...unansweredLines(cores), ...replaceableLines(cores)],
        );
      }
      if (replyTo !== undefined) {
        const target = cores.findLast((core) => core.from === "user" && core.shortId === replyTo);
        if (target === undefined) {
          return yield* placeRefusal(
            "invalid_request",
            [`no message from the user has the id "${replyTo}".`],
            cores,
            undefined,
            unansweredLines(cores),
          );
        }
        const now = yield* Clock.currentTimeMillis;
        const key = holdKey(threadId, target.id);
        const verdict = judgeReplace({
          calls: answerCalls(items, target.id, replyTo, named),
          held: holds.held(key, named, now),
          subject: {
            what: `message "${replyTo}"`,
            replace: `${REPLACE_SEND_TO_USER_TOOL_NAME} with reply_to "${replyTo}"`,
          },
        });
        if (!verdict.ok) {
          return yield* placeRefusal("invalid_request", [verdict.reason], cores, target, []);
        }
        const answer = cores
          .slice(cores.indexOf(target) + 1)
          .findLast((core) => core.replyTo === replyTo);
        if (answer === undefined) {
          return yield* placeRefusal(
            "invalid_request",
            [
              `you have not answered message "${replyTo}", so there is nothing to replace. Use send_to_user.`,
            ],
            cores,
            target,
            [],
          );
        }
        // Once the user has written after an answer, it stays as they read it. That holds for a
        // message typed while this call ran, which only `coresNow` has.
        const answerNow = coresNow.find((core) => core.id === answer.id) ?? answer;
        const later = userAfter(coresNow, answerNow);
        if (later !== undefined) {
          return yield* placeRefusal(
            "invalid_request",
            [
              // judgeSend still takes the answer after an ack that the user replied under.
              answerNow.ack && later.first === answerNow.id
                ? `the user has written after your ack for message "${replyTo}", so it stays as it is. Send your answer to "${replyTo}" with send_to_user and reply_to "${replyTo}".`
                : `the user has written after your ${answerNow.ack ? "ack for" : "answer to"} message "${replyTo}", so it stays as it is. Answer their latest message with send_to_user and reply_to "${later.shortId}".`,
            ],
            coresNow,
            later,
            [],
          );
        }
        const similarity = userSimilarity(input.user_message, target.text);
        const oldSimilarity = textSimilarity(quoted(input.old_text), recapText(answer.text));
        const mismatches = [
          ...(similarity >= TEXT_MATCH_MIN_RATIO
            ? []
            : [userMismatch(similarity, `message "${replyTo}"`, target.text)]),
          ...(oldSimilarity >= TEXT_MATCH_MIN_RATIO
            ? []
            : [
                `old_text is ${percent(oldSimilarity)}% like your answer to it; needs ${MIN_PERCENT}%.`,
              ]),
        ];
        if (mismatches.length > 0) {
          return yield* placeRefusal("invalid_request", mismatches, cores, target, [
            "Your current answer, as old_text:",
            recapText(answer.text),
            CHECK_MESSAGE,
          ]);
        }
        holds.record(key, named, "replace", verdict.next, now);
        if (answer.reply && answer.first !== null)
          yield* subThreadChanged(
            threadId,
            subThreadCores(cores, answer.first).map((core) =>
              core === answer ? { ...core, text: input.new_text } : core,
            ),
            answer.first,
          );
        return SHOWN;
      }
      const message = cores.findLast((core) => isNewMessage(core) && core.shortId === subThread);
      if (message === undefined) {
        return yield* placeRefusal(
          "invalid_request",
          [`none of your messages sent with new_sub_thread has the id "${subThread}".`],
          cores,
          undefined,
          replaceableLines(cores),
        );
      }
      const later = userAfter(coresNow, message);
      if (later !== undefined) {
        return yield* placeRefusal(
          "invalid_request",
          [
            `the user has written after this message, so it stays as it is. Answer their latest message with send_to_user and reply_to "${later.shortId}".`,
          ],
          coresNow,
          later,
          [],
        );
      }
      const oldSimilarity = textSimilarity(quoted(input.old_text), recapText(message.text));
      if (oldSimilarity < TEXT_MATCH_MIN_RATIO) {
        return yield* placeRefusal(
          "invalid_request",
          [`old_text is ${percent(oldSimilarity)}% like that message; needs ${MIN_PERCENT}%.`],
          cores,
          undefined,
          ["Your message, as old_text:", recapText(message.text)],
        );
      }
      return SHOWN;
    });

    return {
      [SEND_TO_USER_TOOL_NAME]: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const { threadId, mode } = yield* callerThread;
          if (!mode.oneSendPerMessage) {
            if (input.text.length > SEND_TO_USER_MAX_LENGTH)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `a message is at most ${SEND_TO_USER_MAX_LENGTH} UTF-16 code units; send the rest in another message.`,
              });
            return { ...SHOWN_NORMAL, sentMessage: input.text };
          }
          const ack = input.ack === true;
          yield* checkMessageSize(input.text, ack);
          if (mode.subThreads)
            return yield* sendInSubThread(threadId, input).pipe(lockFor(threadId).withPermits(1));
          return yield* Effect.gen(function* () {
            const turn = yield* readThreadTurn(threadId);
            if (ack && turn.typed === undefined) {
              return yield* refusal(
                "invalid_request",
                [
                  "an ack answers a message from the user, and they have typed none. Send without ack.",
                ],
                turn,
              );
            }
            const now = yield* Clock.currentTimeMillis;
            const key = holdKey(threadId, turn.typed?.id);
            const verdict = judgeSend({
              calls: turn.calls,
              held: holds.held(key, turn.named, now),
              kind: ack ? "ack" : "answer",
              subject: LAST_MESSAGE,
            });
            if (!verdict.ok) return yield* refusal("invalid_request", [verdict.reason], turn);
            holds.record(key, turn.named, ack ? "ack" : "answer", verdict.next, now);
            return ack ? ACKED : SHOWN;
          }).pipe(lockFor(threadId).withPermits(1));
        }),
      ),
      [REPLACE_SEND_TO_USER_TOOL_NAME]: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const { user_message, old_text, new_text } = input;
          yield* checkMessageSize(new_text);
          const { threadId, mode } = yield* callerThread;
          if (mode.subThreads)
            return yield* replaceInSubThread(threadId, input).pipe(
              lockFor(threadId).withPermits(1),
            );
          return yield* Effect.gen(function* () {
            const turn = yield* readThreadTurn(threadId);
            if (
              messagePointer(input.reply_to) !== undefined ||
              messagePointer(input.sub_thread) !== undefined
            ) {
              return yield* refusal(
                "capability_denied",
                [
                  "this thread is not set to Chat + Replies, so it has no sub-threads. Call replace_send_to_user without reply_to and sub_thread.",
                ],
                turn,
              );
            }
            if (!mode.oneSendPerMessage) {
              return yield* refusal(
                "capability_denied",
                [
                  "replace_send_to_user works only in a thread whose display mode allows one answer from you per message of the user. This thread's mode does not. Use send_to_user.",
                ],
                turn,
              );
            }
            const now = yield* Clock.currentTimeMillis;
            const key = holdKey(threadId, turn.typed?.id);
            const verdict = judgeReplace({
              calls: turn.calls,
              held: holds.held(key, turn.named, now),
              subject: LAST_MESSAGE,
            });
            if (!verdict.ok) return yield* refusal("invalid_request", [verdict.reason], turn);
            if (turn.current === undefined) {
              return yield* refusal(
                "invalid_request",
                [
                  "you have sent no message since the user's last one, so there is nothing to replace. Use send_to_user.",
                ],
                turn,
              );
            }
            const typed = turn.typed?.text ?? "";
            const similarity = userSimilarity(user_message, typed);
            const oldSimilarity = textSimilarity(quoted(old_text), recapText(turn.current.text));
            const mismatches = [
              ...(similarity >= TEXT_MATCH_MIN_RATIO
                ? []
                : [userMismatch(similarity, "the user's last message", typed)]),
              ...(oldSimilarity >= TEXT_MATCH_MIN_RATIO
                ? []
                : [
                    `old_text is ${percent(oldSimilarity)}% like your current message; needs ${MIN_PERCENT}%.`,
                  ]),
            ];
            if (mismatches.length > 0) return yield* refusal("invalid_request", mismatches, turn);
            holds.record(key, turn.named, "replace", verdict.next, now);
            return SHOWN;
          }).pipe(lockFor(threadId).withPermits(1));
        }),
      ),
    };
  }),
);
