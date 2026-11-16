import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  type OrchestrationV2TurnItem,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { serializeAssistantCitation } from "../../assistantCitations.ts";
import { applyServerSettingsPatch } from "../../serverSettings.ts";

import {
  CHAT_REPLIES_DISPLAY_MODE,
  type DisplayEvent,
  displayEventFromTurnItem,
  displayModeShowsText,
  foldCores,
  foldSentTexts,
  isReplaceSendCall,
  freshFirstPointer,
  isWebTypedMessage,
  MESSAGES_DASHBOARD_DISPLAY_MODE,
  MESSAGES_ONLY_DISPLAY_MODE,
  NORMAL_DISPLAY_MODE,
  recapText,
  resolveDisplayMode,
  sentMessageText,
  shortId,
  SUB_THREAD_RECORD_KIND,
  subThreadCores,
} from "./displayModes.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const user = (text: string): DisplayEvent => ({ type: "user", id: `user:${text}`, text });
const sent = (text: string): DisplayEvent => ({ type: "sent", id: `sent:${text}`, text });
const rewrite = (text: string): DisplayEvent => ({ type: "rewrite", id: `rewrite:${text}`, text });
const other: DisplayEvent = { type: "other" };

const wrap = (events: ReadonlyArray<DisplayEvent>, text: string) =>
  MESSAGES_ONLY_DISPLAY_MODE.wrap!(events, text, { id: "typed" });

const wrapped = (lines: ReadonlyArray<string>, text: string) =>
  [
    "<t3-messages-mode>",
    "This message is from the user. Before it, their screen showed:",
    ...lines,
    "</t3-messages-mode>",
    text,
  ].join("\n");

const item = (fields: Record<string, unknown>) =>
  ({
    id: "item-1",
    status: "completed",
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

describe("displayEventFromTurnItem", () => {
  it.each([
    [
      "the user's message",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "web",
        text: "hi",
      },
      { type: "user", id: "m1", text: "hi" },
    ],
    [
      "the user's message from the mobile app",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "mobile",
        text: "hi",
      },
      { type: "user", id: "m1", text: "hi" },
    ],
    [
      "an automatic retry after a usage limit",
      {
        type: "user_message",
        messageId: "m4",
        createdBy: "user",
        creationSource: "server",
        text: "Continue where you left off.",
      },
      { type: "other" },
    ],
    [
      "a user message that the provider made",
      {
        type: "user_message",
        messageId: "m5",
        createdBy: "user",
        creationSource: "provider",
        text: "Background task finished",
      },
      { type: "other" },
    ],
    [
      "the user's /compact, which owes no answer",
      {
        type: "user_message",
        messageId: "m7",
        createdBy: "user",
        creationSource: "web",
        text: " /compact ",
      },
      { type: "user", id: "m7", text: " /compact ", compaction: true },
    ],
    [
      "the user's /compact with a file, which is a prompt",
      {
        type: "user_message",
        messageId: "m8",
        createdBy: "user",
        creationSource: "web",
        text: "/compact",
        attachments: [{ type: "image" }],
      },
      { type: "user", id: "m8", text: "/compact" },
    ],
    [
      "T3 Code's own /compact when the user returns",
      {
        type: "user_message",
        messageId: "m6",
        createdBy: "user",
        creationSource: "web",
        idleCompaction: "onReturn",
        text: "/compact",
      },
      { type: "other" },
    ],
    [
      "a bot's message",
      {
        type: "user_message",
        messageId: "m2",
        createdBy: "agent",
        senderThreadId: "t2",
        text: "From bot",
      },
      { type: "other" },
    ],
    [
      "a scheduled prompt",
      {
        type: "user_message",
        messageId: "m3",
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: "s1",
        text: "Check in",
      },
      { type: "other" },
    ],
    ["assistant text", { type: "assistant_message", text: "Working on it" }, { type: "other" }],
    ["blank assistant text", { type: "assistant_message", text: "  " }, null],
    [
      "a completed send",
      { type: "dynamic_tool", toolName: "mcp__t3-code__send_to_user", input: { text: "Done" } },
      { type: "sent", id: "item-1", text: "Done" },
    ],
    [
      "a completed ack",
      {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: "On it.", ack: true },
      },
      { type: "sent", id: "item-1", text: "On it.", ack: true },
    ],
    [
      "a Normal-mode send, which ignores the other modes' fields",
      {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: "On it.", ack: true, reply_to: "a1b2c3" },
        output: { ok: true, message: "Shown to the user. Don't repeat it.", sentMessage: "On it." },
      },
      { type: "sent", id: "item-1", text: "On it." },
    ],
    [
      "a send with ack false",
      {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: "Done", ack: false },
      },
      { type: "sent", id: "item-1", text: "Done" },
    ],
    [
      "a send with ack null",
      {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: "Done", ack: null },
      },
      { type: "sent", id: "item-1", text: "Done" },
    ],
    [
      "a failed send",
      {
        type: "dynamic_tool",
        status: "failed",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: "Done" },
      },
      { type: "other" },
    ],
    [
      "a send the tool refused, which ACP reports as completed with an error result",
      {
        type: "dynamic_tool",
        toolName: "t3-code.send_to_user",
        input: { text: "Done" },
        output: { content: [{ type: "text", text: "Too long" }], isError: true },
      },
      { type: "other" },
    ],
    [
      "a running send",
      {
        type: "dynamic_tool",
        status: "running",
        toolName: "t3-code.send_to_user",
        input: { text: "Done" },
      },
      null,
    ],
    [
      "a queued message that has not started",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "web",
        text: "next",
        inputIntent: "queued_turn",
        status: "pending",
      },
      null,
    ],
    [
      "a queued message that has started",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "web",
        text: "next",
        inputIntent: "queued_turn",
      },
      { type: "user", id: "m1", text: "next" },
    ],
    [
      "a completed replace",
      {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__replace_send_to_user",
        input: { user_message: "Hi", old_text: "Done", new_text: "Done, and pushed" },
      },
      { type: "rewrite", id: "item-1", text: "Done, and pushed" },
    ],
    [
      "a replace the tool refused",
      {
        type: "dynamic_tool",
        toolName: "t3-code.replace_send_to_user",
        input: { user_message: "Hi", old_text: "Done", new_text: "Done, and pushed" },
        output: { content: [{ type: "text", text: "Refused" }], isError: true },
      },
      { type: "other" },
    ],
    [
      "a cancelled replace",
      {
        type: "dynamic_tool",
        status: "cancelled",
        toolName: "mcp__t3-code__replace_send_to_user",
        input: { user_message: "Hi", old_text: "Done", new_text: "Done, and pushed" },
      },
      { type: "other" },
    ],
    [
      "a running replace",
      {
        type: "dynamic_tool",
        status: "running",
        toolName: "mcp__t3-code__replace_send_to_user",
        input: { user_message: "Hi", old_text: "Done", new_text: "Done, and pushed" },
      },
      null,
    ],
    ["another tool", { type: "dynamic_tool", toolName: "Read", input: {} }, { type: "other" }],
    ["a command", { type: "command_execution", input: "ls" }, { type: "other" }],
    ["a checkpoint", { type: "checkpoint" }, null],
    ["reasoning", { type: "reasoning", text: "thinking" }, { type: "other" }],
  ])("maps %s", (_name, fields, expected) => {
    expect(displayEventFromTurnItem(item(fields))).toEqual(expected);
  });
});

describe("visibleCores", () => {
  it("keeps the user's messages and sent messages in order", () => {
    expect(
      MESSAGES_ONLY_DISPLAY_MODE.visibleCores!([user("A"), other, sent("B"), other, user("C")]),
    ).toMatchObject([
      { id: "user:A", from: "user", text: "A" },
      { id: "sent:B", from: "agent", text: "B" },
      { id: "user:C", from: "user", text: "C" },
    ]);
  });

  it("shows a rewrite as the new text of the latest send before it, even across user messages", () => {
    expect(
      MESSAGES_ONLY_DISPLAY_MODE.visibleCores!([
        sent("A"),
        user("B"),
        sent("C"),
        other,
        user("D"),
        rewrite("C2"),
        rewrite("C3"),
      ]),
    ).toMatchObject([
      { id: "sent:A", from: "agent", text: "A" },
      { id: "user:B", from: "user", text: "B" },
      { id: "sent:C", from: "agent", text: "C3", editedBy: "rewrite:C3" },
      { id: "user:D", from: "user", text: "D" },
    ]);
  });

  it("marks a send edited only by a rewrite that changes its text, and any rewrite ends an ack", () => {
    const ack: DisplayEvent = { type: "sent", id: "sent:On it.", text: "On it.", ack: true };
    const core = { id: "sent:On it.", from: "agent", first: "sent:On it.", reply: false };
    const shortIdOf = { shortId: shortId("On it.") };
    expect(foldCores([ack])).toEqual([{ ...core, ...shortIdOf, text: "On it.", ack: true }]);
    expect(foldCores([ack, rewrite("On it.")])).toEqual([
      { ...core, ...shortIdOf, text: "On it." },
    ]);
    const again: DisplayEvent = { type: "rewrite", id: "again", text: "Done." };
    expect(foldCores([ack, rewrite("Done."), again])).toEqual([
      { ...core, ...shortIdOf, text: "Done.", editedBy: "rewrite:Done." },
    ]);
  });

  it("shows nothing for a rewrite with no send before it", () => {
    expect(MESSAGES_ONLY_DISPLAY_MODE.visibleCores!([rewrite("X"), user("A")])).toMatchObject([
      { id: "user:A", from: "user", text: "A" },
    ]);
  });

  it("is null for Normal, which shows everything", () => {
    expect(NORMAL_DISPLAY_MODE.visibleCores).toBeNull();
    expect(NORMAL_DISPLAY_MODE.wrap).toBeNull();
  });
});

describe("Messages only wrap", () => {
  it("recaps the screen before a direct reply too", () => {
    expect(wrap([user("A"), other, sent("B")], "C")).toBe(wrapped(["[user] A", "[you] B"], "C"));
    expect(wrap([user("A"), other, sent("B"), user("C")], "D")).toBe(
      wrapped(["[user] A", "[you] B", "[user] C"], "D"),
    );
  });

  it("sends the text unchanged when the screen showed nothing before it", () => {
    expect(wrap([], "First")).toBe("First");
    expect(wrap([other, other], "First")).toBe("First");
  });

  const fromItem = (fields: Record<string, unknown>) => displayEventFromTurnItem(item(fields))!;

  it.each([
    ["a tool call", [fromItem({ type: "command_execution", input: "ls" })]],
    ["the agent's plain text", [fromItem({ type: "assistant_message", text: "Done" })]],
    ["reasoning", [fromItem({ type: "reasoning", text: "thinking" })]],
    [
      "a scheduled prompt and the agent's text in a later turn",
      [
        fromItem({
          type: "user_message",
          messageId: "s",
          createdBy: "user",
          scheduledTaskId: "task-1",
          text: "Daily check",
        }),
        fromItem({ type: "assistant_message", text: "Checked" }),
      ],
    ],
    [
      "a bot message",
      [fromItem({ type: "user_message", messageId: "b", createdBy: "agent", text: "From bot" })],
    ],
    [
      "an automatic retry after a usage limit",
      [
        fromItem({
          type: "user_message",
          messageId: "r",
          createdBy: "user",
          creationSource: "server",
          text: "Continue where you left off.",
        }),
      ],
    ],
  ])("wraps after %s", (_name, after) => {
    expect(wrap([user("A"), sent("B"), ...after], "C")).toBe(wrapped(["[user] A", "[you] B"], "C"));
  });

  it("wraps when the agent wrote text between the user's messages", () => {
    const reply = fromItem({ type: "assistant_message", text: "Noted" });
    expect(wrap([user("A"), sent("B"), user("C"), reply, user("D")], "E")).toBe(
      wrapped(["[you] B", "[user] C", "[user] D"], "E"),
    );
  });

  it("wraps the first message when the agent has only written text", () => {
    expect(wrap([user("A"), other], "B")).toBe(wrapped(["[user] A"], "B"));
  });

  it("lists at most 3 earlier cores in real order, two user messages in a row both counted", () => {
    expect(wrap([sent("S0"), user("A"), sent("B"), user("C"), user("D"), other], "E")).toBe(
      wrapped(["[you] B", "[user] C", "[user] D"], "E"),
    );
  });

  it("cuts each core at 2000 UTF-8 bytes on a character boundary", () => {
    const ascii = "a".repeat(2001);
    const chinese = "汉".repeat(700);
    const emoji = `${"a".repeat(1998)}🙂`;
    expect(wrap([user(ascii), user(chinese), user(emoji), other], "E")).toBe(
      wrapped(
        [
          `[user] ${"a".repeat(2000)}…[truncated]`,
          `[user] ${"汉".repeat(666)}…[truncated]`,
          `[user] ${"a".repeat(1998)}…[truncated]`,
        ],
        "E",
      ),
    );
    expect(wrap([user("a".repeat(2000)), other], "E")).toBe(
      wrapped([`[user] ${"a".repeat(2000)}`], "E"),
    );
  });

  it("recaps a rewritten send with its new text, and a rewrite adds no line", () => {
    expect(wrap([user("A"), sent("B"), user("C"), rewrite("B2")], "D")).toBe(
      wrapped(["[user] A", "[you] B2", "[user] C"], "D"),
    );
  });

  it("shows a quote as its quoted text and comment", () => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      text: "the token check",
      start: 0,
      end: 15,
      prefix: "",
      suffix: "",
      comment: "Why here?",
    });
    expect(wrap([user(`Look at ${quote} again`)], "E")).toBe(
      wrapped(["[user] Look at the token check\nComment: Why here? again"], "E"),
    );
  });

  it("wraps the same way in Messages + Dashboard", () => {
    const events = [user("A"), sent("B"), other];
    expect(MESSAGES_DASHBOARD_DISPLAY_MODE.wrap!(events, "C", { id: "typed" })).toBe(
      wrapped(["[user] A", "[you] B"], "C"),
    );
    expect(MESSAGES_DASHBOARD_DISPLAY_MODE.wrap!([], "C", { id: "typed" })).toBe("C");
  });

  it("uses a tag that user-view's <x-mode> pattern strips", () => {
    const text = wrap([user("A"), other], "C");
    // user-view is an outside tool that shows a transcript as the user saw it.
    // It removes the blocks that match this pattern, and then it trims the whitespace around them.
    expect(text.replace(/<([a-z][a-z0-9_-]*-mode)>[\s\S]*?<\/\1>/g, "").trim()).toBe("C");
  });
});

describe("sub-threads", () => {
  const replyUnder = (text: string, under: string): DisplayEvent => ({
    type: "user",
    id: `user:${text}`,
    text,
    under,
  });
  const answer = (text: string, to: string): DisplayEvent => ({
    type: "sent",
    id: `sent:${text}`,
    text,
    replyTo: shortId(`user:${to}`),
  });
  // Two sub-threads, their messages mixed in time: one that the user started and one that the agent did.
  const events: ReadonlyArray<DisplayEvent> = [
    user("Q1"),
    sent("News"),
    answer("A1", "Q1"),
    replyUnder("Why?", "sent:News"),
    other,
    replyUnder("Q2", "user:Q1"),
    answer("Because", "Why?"),
    answer("A2", "Q2"),
  ];

  it("puts an answer where the message it answers is", () => {
    const cores = foldCores([...events, replyUnder("More?", "sent:A1"), answer("Sure", "More?")]);
    expect(cores.filter((core) => !core.reply).map((core) => core.text)).toEqual([
      "Q1",
      "News",
      "A1",
    ]);
    expect(subThreadCores(cores, "user:Q1").map((core) => core.text)).toEqual(["Q1", "Q2", "A2"]);
    expect(subThreadCores(cores, "sent:News").map((core) => core.text)).toEqual([
      "News",
      "Why?",
      "Because",
    ]);
    expect(subThreadCores(cores, "sent:A1").map((core) => core.text)).toEqual([
      "A1",
      "More?",
      "Sure",
    ]);
  });

  it("gives an answer no sub-thread when the message it answers is not among the events", () => {
    expect(foldCores([answer("A1", "Q1")])).toMatchObject([{ reply: true, first: null }]);
    // Until a reply under it shows it is in the main list.
    expect(foldCores([answer("A1", "Q1"), replyUnder("More?", "sent:A1")])).toMatchObject([
      { id: "sent:A1", reply: false, first: "sent:A1" },
      { reply: true, first: "sent:A1" },
    ]);
  });

  it("rewrites the answer or the first message that the call names, not the latest send", () => {
    const cores = foldCores([
      ...events,
      { type: "rewrite", id: "r1", text: "A1 fixed", replyTo: shortId("user:Q1") },
      { type: "rewrite", id: "r2", text: "News fixed", subThread: shortId("News") },
    ]);
    expect(cores.map((core) => core.text)).toEqual([
      "Q1",
      "News fixed",
      "A1 fixed",
      "Why?",
      "Q2",
      "Because",
      "A2",
    ]);
    expect(cores.map((core) => core.editedBy)).toEqual([
      undefined,
      "r2",
      "r1",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("names the agent's first message by the text it was sent with, also after a rewrite", () => {
    const cores = foldCores([
      sent("News"),
      { type: "rewrite", id: "r1", text: "News 2", subThread: shortId("News") },
      { type: "rewrite", id: "r2", text: "News 3", subThread: shortId("News") },
    ]);
    expect(cores).toMatchObject([{ text: "News 3", shortId: shortId("News") }]);
  });

  it("names a first message by the id that its send returned, and else by its text", () => {
    // Two first messages with the same words: each send returned an id of its own.
    const cores = foldCores([
      { type: "sent", id: "s1", text: "News", pointer: "aaaaaa" },
      { type: "sent", id: "s2", text: "News", pointer: "bbbbbb" },
      sent("Old news"),
      { type: "rewrite", id: "r1", text: "First news, fixed", subThread: "aaaaaa" },
    ]);
    expect(cores).toMatchObject([
      { text: "First news, fixed", shortId: "aaaaaa" },
      { text: "News", shortId: "bbbbbb" },
      { text: "Old news", shortId: shortId("Old news") },
    ]);
  });

  it("gives a new first message an id that no shown message has", () => {
    const taken = new Set(foldCores([sent("News"), user("Q1")]).map((core) => core.shortId));
    expect(freshFirstPointer(taken, "Other news")).toBe(shortId("Other news"));
    const fresh = freshFirstPointer(taken, "News");
    expect(taken).not.toContain(fresh);
    expect(freshFirstPointer(new Set([...taken, fresh]), "News")).not.toBe(fresh);
  });

  it("tells the agent the id of a main-list message and where its answer shows, with no recap", () => {
    expect(CHAT_REPLIES_DISPLAY_MODE.wrap!(events, "Q3", { id: "user:Q3" })).toBe(
      [
        "<t3-replies-mode>",
        `Message "${shortId("user:Q3")}" from the user in the main list.`,
        `To answer, call send_to_user with reply_to "${shortId("user:Q3")}" and the user's words below as user_message. Your answer shows in the main list.`,
        "</t3-replies-mode>",
        "Q3",
      ].join("\n"),
    );
  });

  it("recaps only the reply's own sub-thread: its first message, then its latest 3 others", () => {
    const longer = [...events, replyUnder("Q3", "user:Q1"), answer("A3", "Q3")];
    expect(CHAT_REPLIES_DISPLAY_MODE.wrap!(longer, "Q4", { id: "user:Q4", under: "user:Q1" })).toBe(
      [
        "<t3-replies-mode>",
        `Message "${shortId("user:Q4")}" from the user, a reply in the sub-thread that showed:`,
        "[user] Q1",
        "[you] A2",
        "[user] Q3",
        "[you] A3",
        `To answer, call send_to_user with reply_to "${shortId("user:Q4")}" and the user's words below as user_message. Your answer shows in this sub-thread.`,
        "</t3-replies-mode>",
        "Q4",
      ].join("\n"),
    );
  });

  it("uses a tag that user-view's <x-mode> pattern strips", () => {
    const text = CHAT_REPLIES_DISPLAY_MODE.wrap!([], "C", { id: "typed" });
    expect(text.replace(/<([a-z][a-z0-9_-]*-mode)>[\s\S]*?<\/\1>/g, "").trim()).toBe("C");
  });

  it("reads a reply's first message from its context record, and a call's pointers from its input", () => {
    expect(
      displayEventFromTurnItem(
        item({
          type: "user_message",
          messageId: "m2",
          createdBy: "user",
          creationSource: "web",
          text: "Why?",
          context: {
            version: 1,
            records: [
              {
                version: 1,
                contextId: "reply",
                kind: SUB_THREAD_RECORD_KIND,
                label: "",
                payload: { first: "item-news" },
              },
            ],
          },
        }),
      ),
    ).toEqual({ type: "user", id: "m2", text: "Why?", under: "item-news" });
    expect(
      displayEventFromTurnItem(
        item({
          type: "dynamic_tool",
          toolName: "mcp__t3-code__send_to_user",
          // The tools accept an id with space around it, so the fold reads it the same way.
          input: { text: "Because", reply_to: " abc123\n", user_message: "Why?" },
        }),
      ),
    ).toEqual({ type: "sent", id: "item-1", text: "Because", replyTo: "abc123" });
    expect(
      displayEventFromTurnItem(
        item({
          type: "dynamic_tool",
          toolName: "mcp__t3-code__send_to_user",
          input: { text: "News", new_sub_thread: true },
          output: { structuredContent: { ok: true, message: "Shown.", messageId: "def456" } },
        }),
      ),
    ).toEqual({ type: "sent", id: "item-1", text: "News", pointer: "def456" });
    expect(
      displayEventFromTurnItem(
        item({
          type: "dynamic_tool",
          toolName: "mcp__t3-code__replace_send_to_user",
          input: { user_message: "", old_text: "News", new_text: "News 2", sub_thread: "def456 " },
        }),
      ),
    ).toEqual({ type: "rewrite", id: "item-1", text: "News 2", subThread: "def456" });
  });
});

describe("recapText", () => {
  it("cuts a message at 2000 UTF-8 bytes after quotes become their text", () => {
    expect(recapText("a".repeat(2000))).toBe("a".repeat(2000));
    expect(recapText("汉".repeat(700))).toBe(`${"汉".repeat(666)}…[truncated]`);
  });
});

describe("resolveDisplayMode", () => {
  it("falls back to Normal for a missing or unknown id", () => {
    expect(resolveDisplayMode(undefined)).toBe(NORMAL_DISPLAY_MODE);
    expect(resolveDisplayMode("retired-experiment")).toBe(NORMAL_DISPLAY_MODE);
    expect(resolveDisplayMode("messages-only")).toBe(MESSAGES_ONLY_DISPLAY_MODE);
    expect(resolveDisplayMode("messages-dashboard")).toBe(MESSAGES_DASHBOARD_DISPLAY_MODE);
    expect(resolveDisplayMode("chat-replies")).toBe(CHAT_REPLIES_DISPLAY_MODE);
  });

  it("gives only Messages + Dashboard a Dashboard", () => {
    expect(
      ["normal", "messages-only", "messages-dashboard", "chat-replies"].map(
        (id) => resolveDisplayMode(id).dashboard,
      ),
    ).toEqual([false, false, true, false]);
  });
});

describe("oneSendPerMessage", () => {
  it("limits the agent to one send per typed message only where the user sees only messages", () => {
    expect(
      ["normal", "messages-only", "messages-dashboard", "chat-replies"].map(
        (id) => resolveDisplayMode(id).oneSendPerMessage,
      ),
    ).toEqual([false, true, true, true]);
  });
});

describe("threadDisplayModes setting", () => {
  it("sets and clears one thread without touching the others", () => {
    const set = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadDisplayModes: { "thread-a": "messages-only", "thread-b": "messages-only" },
    });
    const cleared = applyServerSettingsPatch(set, { threadDisplayModes: { "thread-a": null } });
    expect(cleared.threadDisplayModes).toEqual({ "thread-b": "messages-only" });
  });

  it("decodes settings written before the setting existed", () => {
    expect(decodeServerSettings({}).threadDisplayModes).toEqual({});
  });
});

describe("isWebTypedMessage", () => {
  it.each([
    ["web", true],
    ["mobile", false],
    ["server", false],
  ] as const)("returns the right answer for a user's message from %s", (creationSource, web) => {
    expect(isWebTypedMessage({ createdBy: "user", creationSource })).toBe(web);
  });

  it("returns false for a scheduled message from the web app", () => {
    expect(
      isWebTypedMessage({ createdBy: "user", creationSource: "web", scheduledTaskId: "task" }),
    ).toBe(false);
  });
});

describe("displayModeShowsText", () => {
  const send = (status: string) =>
    item({
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text: "hi" },
      status,
    });
  const assistant = item({ type: "assistant_message", messageId: "m2", text: "hi" });
  const typed = item({
    type: "user_message",
    messageId: "m1",
    createdBy: "user",
    creationSource: "web",
    text: "hi",
  });
  const tool = item({ type: "dynamic_tool", toolName: "Read", input: {} });

  it.each([
    ["normal", typed, true],
    ["normal", assistant, true],
    ["normal", send("completed"), true],
    ["normal", send("failed"), false],
    ["normal", send("running"), false],
    ["normal", tool, false],
    ["messages-only", typed, true],
    ["messages-only", assistant, false],
    ["messages-only", send("completed"), true],
    ["messages-only", send("failed"), false],
    ["messages-only", tool, false],
    ["messages-dashboard", typed, true],
    ["messages-dashboard", assistant, false],
    ["messages-dashboard", send("completed"), true],
    ["messages-dashboard", tool, false],
  ])("for mode %s and item %#", (modeId, turnItem, shown) => {
    expect(displayModeShowsText(modeId, turnItem)).toBe(shown);
  });
});

const replace = (id: string, newText: string, status = "completed", pointer = {}) =>
  item({
    id,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__replace_send_to_user",
    input: { user_message: "", old_text: "", new_text: newText, ...pointer },
    status,
  });

describe("sentMessageText", () => {
  it("returns the text of a completed send only", () => {
    const send = {
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text: "hi" },
    };
    expect(sentMessageText(item(send))).toBe("hi");
    expect(sentMessageText(item({ ...send, status: "failed" }))).toBeNull();
    expect(sentMessageText(item({ type: "command_execution", input: "ls" }))).toBeNull();
    expect(sentMessageText(replace("r", "hi"))).toBeNull();
  });
});

describe("foldSentTexts", () => {
  const send = (id: string, text: string) =>
    item({ id, type: "dynamic_tool", toolName: "mcp__t3-code__send_to_user", input: { text } });
  const typed = (id: string) =>
    item({
      type: "user_message",
      messageId: id,
      createdBy: "user",
      creationSource: "web",
      text: id,
    });

  it("gives each send the text of its latest rewrite, and replace calls no entry", () => {
    expect(
      foldSentTexts([
        send("s1", "First"),
        replace("r1", "First, fixed"),
        typed("u1"),
        send("s2", "Second"),
        replace("r2", "Not shown", "failed"),
        typed("u2"),
        replace("r3", "Second, fixed"),
      ]),
    ).toEqual(
      new Map([
        ["s1", "First, fixed"],
        ["s2", "Second, fixed"],
      ]),
    );
  });

  it("keeps the latest rewrite before the first send by its own id, when asked", () => {
    const items = [replace("r1", "Old fix"), replace("r2", "New fix"), send("s1", "Next")];
    expect(foldSentTexts(items)).toEqual(new Map([["s1", "Next"]]));
    expect(foldSentTexts(items, { unmatchedRewrite: true })).toEqual(
      new Map([
        ["s1", "Next"],
        ["r2", "New fix"],
      ]),
    );
  });

  it("keeps a rewrite that names a send before the items, also after a send among them", () => {
    const named = (id: string, text: string, pointer: Record<string, string>) =>
      replace(id, text, "completed", pointer);
    const items = [
      send("s1", "Next"),
      named("r1", "Old answer, fixed", { reply_to: "aaaaaa" }),
      named("r2", "Old answer, fixed again", { reply_to: "aaaaaa" }),
      named("r3", "Old first message, fixed", { sub_thread: "bbbbbb" }),
    ];
    expect(foldSentTexts(items)).toEqual(new Map([["s1", "Next"]]));
    expect(foldSentTexts(items, { unmatchedRewrite: true })).toEqual(
      new Map([
        ["s1", "Next"],
        ["r2", "Old answer, fixed again"],
        ["r3", "Old first message, fixed"],
      ]),
    );
  });
});

describe("isReplaceSendCall", () => {
  it("names a replace call in any state, and nothing else", () => {
    expect(isReplaceSendCall(replace("r", "x", "running"))).toBe(true);
    expect(isReplaceSendCall(replace("r", "x", "failed"))).toBe(true);
    expect(
      isReplaceSendCall(
        item({
          type: "dynamic_tool",
          toolName: "mcp__t3-code__send_to_user",
          input: { text: "x" },
        }),
      ),
    ).toBe(false);
  });

  it("is never drawn as text", () => {
    for (const modeId of ["normal", "messages-only", "messages-dashboard"])
      expect(displayModeShowsText(modeId, replace("r", "x"))).toBe(false);
  });

  it("names an OpenCode replace call, whose label also ends with send_to_user", () => {
    expect(
      isReplaceSendCall(
        item({
          type: "dynamic_tool",
          toolName: "t3-code-thread_opencode2-adapter_replace_send_to_user",
          input: { user_message: "", old_text: "", new_text: "x" },
        }),
      ),
    ).toBe(true);
    expect(
      isReplaceSendCall(
        item({
          type: "dynamic_tool",
          toolName: "t3-code-thread_opencode2-adapter_send_to_user",
          input: { text: "x" },
        }),
      ),
    ).toBe(false);
  });
});
