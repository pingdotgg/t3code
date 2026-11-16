import { expect, it } from "@effect/vitest";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { recapLine, shortId, SUB_THREAD_RECORD_KIND } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DisplayModeWrap } from "../displayModeWrap/DisplayModeWrap.ts";
import * as SubThreads from "../subThreads/SubThreads.ts";
import * as SendToUser from "./SendToUser.ts";

const repliesThread = ThreadId.make("sub-threads:chat-replies");

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("sub-threads-environment"),
  requestNamespace: "sub-threads-session",
  thread: {
    threadId,
    providerSessionId: "sub-threads-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(),
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "sub-threads", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sub-threads", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const time = DateTime.makeUnsafe("2026-11-11T00:00:00.000Z");
let ordinal = 0;
const base = (id: string) => ({
  id: TurnItemId.make(id),
  threadId: repliesThread,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: `toolu_${id}`,
    strength: "strong" as const,
  },
  parentItemId: null,
  ordinal: ordinal++,
  status: "completed" as const,
  title: null,
  startedAt: time,
  completedAt: time,
  updatedAt: time,
});
/** A message that the user typed: in the main list, or under the first message `under`. */
const typed = (id: string, text: string, under?: string) =>
  ({
    ...base(id),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
    ...(under === undefined
      ? {}
      : {
          context: {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                contextId: ComposerContextId.make(`reply-${id}`),
                kind: SUB_THREAD_RECORD_KIND,
                label: "",
                payload: { first: under },
              },
            ],
          },
        }),
  }) as OrchestrationV2TurnItem;
const sent = (id: string, input: Record<string, unknown>) =>
  ({
    ...base(id),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input,
  }) satisfies OrchestrationV2TurnItem;
const answer = (id: string, text: string, to: string) =>
  sent(id, { text, reply_to: shortId(to), user_message: "" });
const ackOf = (id: string, text: string, to: string) =>
  sent(id, { text, reply_to: shortId(to), user_message: "", ack: true });
const news = (id: string, text: string) => sent(id, { text, new_sub_thread: true });

let history: ReadonlyArray<OrchestrationV2TurnItem> = [];
let changes: Array<{ readonly firstId: string; readonly lines: ReadonlyArray<string> }> = [];
const setup = (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
  history = items;
  changes = [];
};

const layer = McpHttpServer.toolkitRegistration(
  SendToUser.SendToUserToolkit,
  SendToUser.layerHandlers,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    ServerSettings.layerTest({
      threadDisplayModes: { [repliesThread]: "chat-replies" },
    }),
  ),
  Layer.provide(
    Layer.mock(DisplayModeWrap)({
      // As the real read: the latest `cores` messages, or back to the main list's latest message.
      latestShownItems: (_threadId, _ownNativeId, cores, toMainListMessage) =>
        Effect.succeed(
          cores === undefined || toMainListMessage === true ? history : history.slice(-cores),
        ),
      forgetNotesAfterCompaction: () => (ingest) => ingest,
    }),
  ),
  Layer.provide(
    Layer.mock(SubThreads.SubThreads)({
      changed: ({ firstId, thread }) =>
        Effect.sync(() => void changes.push({ firstId, lines: thread.map(recapLine) })),
    }),
  ),
);

/** Calls a tool. With `ownItem`, the provider names the call, as Claude does: its item is in the history. */
const call = (
  name: "send_to_user" | "replace_send_to_user",
  args: Record<string, unknown>,
  threadId: ThreadId = repliesThread,
  ownItem?: string,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
    Effect.provideService(
      McpSchema.McpServerClient,
      ownItem === undefined
        ? client
        : McpSchema.McpServerClient.of({
            ...client,
            requestMetadata: { "claudecode/toolUseId": `toolu_${ownItem}` },
          }),
    ),
  );

const refusalLines = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  const block = result.content[0];
  return (block?.type === "text" ? block.text : "").split("\n");
};
const DONE = "If you are done, end your turn with no text.";
const shown = (message: string) => ({ ok: true, message: `${message} ${DONE}` });

// The user's question with its answer and a follow-up that old history put under the question, and
// the agent's news with a reply.
const twoSubThreads = () => [
  typed("q1", "Is the build green?"),
  news("n1", "The deploy is done."),
  answer("a1", "Yes, all checks pass.", "q1"),
  typed("why", "Which build was deployed?", "n1"),
  typed("q2", "And the lint job?", "q1"),
];

it.effect("refuses a send that names neither a message to answer nor a new sub-thread", () =>
  Effect.gen(function* () {
    // An ack is not an answer, so its message stays in the list.
    setup([...twoSubThreads(), ackOf("k2", "On it.", "q2")]);
    for (const args of [
      { text: "Lint passes too." },
      { text: "Lint passes too.", reply_to: "", new_sub_thread: false },
      { text: "Lint passes too.", reply_to: shortId("q2"), new_sub_thread: true },
    ]) {
      expect(refusalLines(yield* call("send_to_user", args))).toEqual([
        "Refused: this thread is in Chat mode. To answer a message from the user, pass reply_to with its id and user_message with its words. For a message that answers none, pass new_sub_thread true and no reply_to.",
        "Messages from the user with no answer yet, by id:",
        `"${shortId("why")}": Which build was deployed?`,
        `"${shortId("q2")}": And the lint job?`,
      ]);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("shows a new message and returns the id that names it", () =>
  Effect.gen(function* () {
    const asked = [typed("q3", "Anything else?"), answer("a3", "No.", "q3")];
    setup([...twoSubThreads(), ...asked]);
    const result = yield* call("send_to_user", {
      text: "CI is red on main.",
      new_sub_thread: true,
    });
    expect(result.structuredContent).toEqual({
      ...shown(
        `Shown to the user as a new message with the id "${shortId("CI is red on main.")}".`,
      ),
      messageId: shortId("CI is red on main."),
    });
    expect(changes).toEqual([]);
    // The same words again after the user writes in the main list, before the first send is in
    // the history, get their own id.
    setup([
      ...twoSubThreads(),
      ...asked,
      typed("q4", "And the docs?"),
      answer("a4", "They are fine.", "q4"),
    ]);
    const together = yield* call("send_to_user", {
      text: "CI is red on main.",
      new_sub_thread: true,
    });
    expect(together.structuredContent).toMatchObject({
      messageId: shortId("CI is red on main.\n1"),
    });
    // The same words as an earlier first message get an id of their own, kept in the result.
    setup([...twoSubThreads(), typed("q5", "And the tests?"), answer("a5", "They pass.", "q5")]);
    const again = yield* call("send_to_user", {
      text: "The deploy is done.",
      new_sub_thread: true,
    });
    const id = shortId("The deploy is done.\n1");
    expect(again.structuredContent).toEqual({
      ...shown(`Shown to the user as a new message with the id "${id}".`),
      messageId: id,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("takes one new message in the main list until the user sends one there", () =>
  Effect.gen(function* () {
    const news2 = { text: "CI is red on main.", new_sub_thread: true };
    const taken =
      "Refused: you already sent a new message to the main list, and the user has not written there since. You may not send two in a row there.";
    const delivering =
      "That message is still being delivered. To change it once it shows, call replace_send_to_user with sub_thread set to the id that its send returned.";
    const unanswered = (...ids: ReadonlyArray<readonly [string, string]>) => [
      "Messages from the user with no answer yet, by id:",
      ...ids.map(([id, text]) => `"${shortId(id)}": ${text}`),
    ];
    const running = (item: OrchestrationV2TurnItem) => ({ ...item, status: "running" }) as const;

    // The user's replies under the agent's news are in its sub-thread, not in the main list.
    setup(twoSubThreads());
    expect(refusalLines(yield* call("send_to_user", news2))).toEqual([
      taken,
      "The user has replied under it, so it stays as it is.",
      ...unanswered(["why", "Which build was deployed?"], ["q2", "And the lint job?"]),
      DONE,
    ]);
    // However long the sub-thread under it grows.
    setup([
      typed("q0", "Ship it."),
      news("n0", "Shipped."),
      ...Array.from({ length: 130 }, (_, index) => typed(`r${index}`, "And?", "n0")),
    ]);
    expect(refusalLines(yield* call("send_to_user", news2))[0]).toBe(taken);
    setup([typed("q1", "Is the build green?"), news("n1", "The deploy is done.")]);
    expect(refusalLines(yield* call("send_to_user", news2))).toEqual([
      taken,
      "To change it, call replace_send_to_user with sub_thread set to its id:",
      `"${shortId("The deploy is done.")}": The deploy is done.`,
      ...unanswered(["q1", "Is the build green?"]),
      DONE,
    ]);

    // A send not stored yet holds the main list too.
    setup([...twoSubThreads(), typed("q3", "Anything else?"), answer("a3", "No.", "q3")]);
    expect((yield* call("send_to_user", news2)).isError).not.toBe(true);
    expect(refusalLines(yield* call("send_to_user", news2)).slice(0, 2)).toEqual([
      taken,
      delivering,
    ]);

    // A named call counts a new message still running before it, and not the agent's older news.
    setup([
      news("n0", "The deploy is done."),
      typed("q4", "Anything else?"),
      answer("a4", "No.", "q4"),
      running(news("s1", "Lint is red.")),
      running(news("s2", "CI is red.")),
    ]);
    expect(refusalLines(yield* call("send_to_user", news2, repliesThread, "s2"))).toEqual([
      taken,
      delivering,
      DONE,
    ]);
    expect((yield* call("send_to_user", news2, repliesThread, "s1")).isError).not.toBe(true);
    // A running call that the handler refuses takes nothing.
    setup([
      typed("q5", "Anything else?"),
      answer("a5", "No.", "q5"),
      running(sent("s3", { text: "Lint is red." })),
      running(sent("s4", { text: "On it.", new_sub_thread: true, ack: true })),
      running(news("s6", "a".repeat(1001))),
      running(news("s7", "")),
      running(news("s5", "CI is red.")),
    ]);
    expect((yield* call("send_to_user", news2, repliesThread, "s5")).isError).not.toBe(true);

    // An ack and an answer in the main list are no new messages, and a replace adds no message.
    setup([
      typed("q6", "Is the build green?"),
      ackOf("k6", "Checking.", "q6"),
      answer("a6", "Yes.", "q6"),
    ]);
    expect((yield* call("send_to_user", news2)).isError).not.toBe(true);
    setup([
      news("n7", "The deploy is done."),
      typed("q7", "Anything else?"),
      {
        ...sent("r7", {
          sub_thread: shortId("The deploy is done."),
          user_message: "",
          old_text: "The deploy is done.",
          new_text: "The deploy is done and checked.",
        }),
        toolName: "mcp__t3-code__replace_send_to_user",
      },
    ]);
    expect((yield* call("send_to_user", news2)).isError).not.toBe(true);

    // A message the user sends to the main list opens it again, once it has its answer.
    setup([...twoSubThreads(), typed("q8", "Anything else?"), answer("a8", "No.", "q8")]);
    expect((yield* call("send_to_user", news2)).isError).not.toBe(true);

    // A `/compact` is not the user writing in the main list, and a new message may answer none.
    setup([news("n9", "The deploy is done."), typed("c9", "/compact")]);
    expect(refusalLines(yield* call("send_to_user", news2))[0]).toBe(taken);
    setup([typed("q10", "Is the build green?"), ackOf("k10", "Checking.", "q10")]);
    expect((yield* call("send_to_user", news2)).isError).not.toBe(true);
    // An answer is no new message; the refusal names only the new message.
    setup([
      typed("q11", "Is the build green?"),
      answer("a11", "Yes.", "q11"),
      news("n11", "The deploy is done."),
    ]);
    expect(refusalLines(yield* call("send_to_user", news2))).toEqual([
      taken,
      "To change it, call replace_send_to_user with sub_thread set to its id:",
      `"${shortId("The deploy is done.")}": The deploy is done.`,
      DONE,
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("shows an answer to the latest user message of each place, in any order", () =>
  Effect.gen(function* () {
    setup([
      ...twoSubThreads(),
      typed("more", "Which checks?", "a1"),
      typed("q3", "Anything else?"),
    ]);
    const first = yield* call("send_to_user", {
      text: "Build 20261111.",
      reply_to: shortId("why"),
      user_message: "Which build was deployed?",
    });
    expect(first.structuredContent).toEqual(
      shown(`Shown to the user as your answer to "${shortId("why")}", in its sub-thread.`),
    );
    const main = yield* call("send_to_user", {
      text: "No, that is all.",
      reply_to: shortId("q3"),
      user_message: "Anything else?",
    });
    expect(main.structuredContent).toEqual(
      shown(`Shown to the user as your answer to "${shortId("q3")}", in the main list.`),
    );
    const second = yield* call("send_to_user", {
      text: "Lint passes too.",
      reply_to: shortId("q2"),
      user_message: "[user] And the lint job?",
    });
    expect(second.structuredContent).toEqual(
      shown(`Shown to the user as your answer to "${shortId("q2")}", in its sub-thread.`),
    );
    // A reply under the answer in the main list is answered in the answer's sub-thread.
    const under = yield* call("send_to_user", {
      text: "Lint, types and tests.",
      reply_to: shortId("more"),
      user_message: "Which checks?",
    });
    expect(under.structuredContent).toEqual(
      shown(`Shown to the user as your answer to "${shortId("more")}", in its sub-thread.`),
    );
    // The answer in the main list starts no summary.
    expect(changes).toEqual([
      {
        firstId: "n1",
        lines: [
          "[you] The deploy is done.",
          "[user] Which build was deployed?",
          "[you] Build 20261111.",
        ],
      },
      {
        firstId: "q1",
        lines: ["[user] Is the build green?", "[user] And the lint job?", "[you] Lint passes too."],
      },
      {
        firstId: "a1",
        lines: [
          "[you] Yes, all checks pass.",
          "[user] Which checks?",
          "[you] Lint, types and tests.",
        ],
      },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses an id that no user message has", () =>
  Effect.gen(function* () {
    setup(twoSubThreads());
    const lines = refusalLines(
      yield* call("send_to_user", { text: "Hm.", reply_to: "ffffff", user_message: "?" }),
    );
    expect(lines.slice(0, 2)).toEqual([
      'Refused: no message from the user has the id "ffffff".',
      "Messages from the user with no answer yet, by id:",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses words unlike the named message, with its place to check", () =>
  Effect.gen(function* () {
    setup(twoSubThreads());
    const result = yield* call("send_to_user", {
      text: "Lint passes too.",
      reply_to: shortId("why"),
      user_message: "And the lint job?",
    });
    expect(refusalLines(result)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Refused: user_message is \\d+% like message "${shortId("why")}"; needs 70%\\.$`,
        ),
      ),
      "That message's sub-thread shows:",
      "[you] The deploy is done.",
      "[user] Which build was deployed?",
      "Check that this is the message you mean to answer.",
    ]);
    const main = yield* call("send_to_user", {
      text: "Yes.",
      reply_to: shortId("q1"),
      user_message: "And the lint job?",
    });
    expect(refusalLines(main).slice(1)).toEqual([
      "The main list shows:",
      "[user] Is the build green?",
      "[you] The deploy is done.",
      "[you] Yes, all checks pass.",
      "Check that this is the message you mean to answer.",
    ]);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses an answer to a message that the user followed up in the same place", () =>
  Effect.gen(function* () {
    const q1 = { text: "Yes.", reply_to: shortId("q1"), user_message: "Is the build green?" };
    setup([typed("q1", "Is the build green?"), typed("q2", "And the lint job?")]);
    expect(refusalLines(yield* call("send_to_user", q1))).toEqual([
      `Refused: the user sent a later message, "${shortId("q2")}", in the main list. Answer that one.`,
      "The main list shows:",
      "[user] Is the build green?",
      "[user] And the lint job?",
    ]);
    setup([
      news("n1", "The deploy is done."),
      typed("why", "Which build?", "n1"),
      typed("why2", "And when?", "n1"),
    ]);
    expect(
      refusalLines(
        yield* call("send_to_user", {
          text: "Build 20261111.",
          reply_to: shortId("why"),
          user_message: "Which build?",
        }),
      ),
    ).toEqual([
      `Refused: the user sent a later message, "${shortId("why2")}", in this sub-thread. Answer that one.`,
      "That message's sub-thread shows:",
      "[you] The deploy is done.",
      "[user] Which build?",
      "[user] And when?",
    ]);
    // A reply that old history put under the question is in another place.
    setup([typed("q1", "Is the build green?"), typed("q2", "And the lint job?", "q1")]);
    expect((yield* call("send_to_user", q1)).isError).not.toBe(true);
    // `/compact` is not a later message.
    setup([
      typed("q3", "Is the build green?"),
      ackOf("k3", "Checking.", "q3"),
      typed("c3", "/compact"),
    ]);
    const after = yield* call("send_to_user", { ...q1, reply_to: shortId("q3") });
    expect(after.isError).not.toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a second answer to one message, and points to the replace tool", () =>
  Effect.gen(function* () {
    // The stored answer named the message with space around the id, which the tool accepts.
    setup([
      ...twoSubThreads(),
      sent("a2", { text: "Lint passes too.", reply_to: ` ${shortId("q2")}\n`, user_message: "" }),
    ]);
    const lines = refusalLines(
      yield* call("send_to_user", {
        text: "Also: types pass.",
        reply_to: shortId("q2"),
        user_message: "And the lint job?",
      }),
    );
    expect(lines[0]).toBe(
      `Refused: you already answered message "${shortId("q2")}". To change your answer, call replace_send_to_user with reply_to "${shortId("q2")}".`,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("does not count a send made in Normal as an answer, though it passed reply_to", () =>
  Effect.gen(function* () {
    setup([
      ...twoSubThreads(),
      {
        ...answer("a2", "Lint passes too.", "q2"),
        output: {
          ok: true,
          message: "Shown to the user. Don't repeat it.",
          sentMessage: "Lint passes too.",
        },
      },
    ]);
    const result = yield* call("send_to_user", {
      text: "Also: types pass.",
      reply_to: shortId("q2"),
      user_message: "And the lint job?",
    });
    expect(result.structuredContent).toEqual(
      shown(`Shown to the user as your answer to "${shortId("q2")}", in its sub-thread.`),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("takes one ack before the answer to a message, and none for a new message", () =>
  Effect.gen(function* () {
    setup(twoSubThreads());
    const q2 = { reply_to: shortId("q2"), user_message: "And the lint job?" };
    const ack = yield* call("send_to_user", { text: "Checking.", ack: true, ...q2 });
    expect(ack.structuredContent).toEqual({
      ok: true,
      message: "Shown to the user as an ack. Send your answer when it is ready.",
    });
    expect(changes).toEqual([]);
    expect(
      refusalLines(yield* call("send_to_user", { text: "Still checking.", ack: true, ...q2 }))[0],
    ).toBe(
      `Refused: you already sent an ack for message "${shortId("q2")}". Send your answer without ack, or make the ack your answer with replace_send_to_user with reply_to "${shortId("q2")}".`,
    );
    const answer = yield* call("send_to_user", { text: "Lint passes too.", ...q2 });
    expect(answer.isError).not.toBe(true);
    expect(changes.map((change) => change.lines.at(-1))).toEqual(["[you] Lint passes too."]);
    expect(
      refusalLines(yield* call("send_to_user", { text: "Done.", ack: true, ...q2 }))[0],
    ).toContain("an ack goes only before the answer");
    const fresh = yield* call("send_to_user", { text: "On it.", ack: true, new_sub_thread: true });
    expect(refusalLines(fresh)[0]).toBe(
      "Refused: an ack answers a message from the user, so it needs reply_to. Send a new message without ack.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("holds an accepted answer against a second one that arrives before it is stored", () =>
  Effect.gen(function* () {
    setup(twoSubThreads());
    const args = {
      text: "Lint passes too.",
      reply_to: shortId("q2"),
      user_message: "And the lint job?",
    };
    expect((yield* call("send_to_user", args)).isError).not.toBe(true);
    expect(refusalLines(yield* call("send_to_user", args))[0]).toContain("you already answered");
    const other = yield* call("send_to_user", {
      text: "Build 20261111.",
      reply_to: shortId("why"),
      user_message: "Which build was deployed?",
    });
    expect(other.isError).not.toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("holds a replace that makes an ack the answer, before the replace is stored", () =>
  Effect.gen(function* () {
    setup([...twoSubThreads(), ackOf("k2", "Checking.", "q2")]);
    const replaced = yield* call("replace_send_to_user", {
      reply_to: shortId("q2"),
      user_message: "And the lint job?",
      old_text: "Checking.",
      new_text: "Lint passes too.",
    });
    expect(replaced.isError).not.toBe(true);
    const again = yield* call("send_to_user", {
      text: "Types pass too.",
      reply_to: shortId("q2"),
      user_message: "And the lint job?",
    });
    expect(refusalLines(again)[0]).toContain("you already answered");
  }).pipe(Effect.provide(layer)),
);

it.effect("replaces the answer to the named message only", () =>
  Effect.gen(function* () {
    setup([...twoSubThreads(), answer("a2", "Lint passes too.", "q2")]);
    const replaced = yield* call("replace_send_to_user", {
      reply_to: shortId("q2"),
      user_message: "And the lint job?",
      old_text: "Lint passes too.",
      new_text: "Lint and types pass.",
    });
    expect(replaced.structuredContent).toEqual(shown("Shown to the user."));
    expect(changes.at(-1)).toEqual({
      firstId: "q1",
      lines: [
        "[user] Is the build green?",
        "[user] And the lint job?",
        "[you] Lint and types pass.",
      ],
    });
    const unlike = refusalLines(
      yield* call("replace_send_to_user", {
        reply_to: shortId("q2"),
        user_message: "And the lint job?",
        old_text: "Yes, all checks pass.",
        new_text: "Lint and types pass.",
      }),
    );
    expect(unlike[0]).toMatch(/^Refused: old_text is \d+% like your answer to it; needs 70%\.$/);
    expect(unlike.slice(-3)).toEqual([
      "Your current answer, as old_text:",
      "Lint passes too.",
      "Check that this is the message you mean to answer.",
    ]);
    // The answer to q1 is in the main list: a reply that old history put under q1 leaves it open.
    const q1 = {
      reply_to: shortId("q1"),
      user_message: "Is the build green?",
      old_text: "Yes, all checks pass.",
      new_text: "Yes.",
    };
    const changed = changes.length;
    expect((yield* call("replace_send_to_user", q1)).isError).not.toBe(true);
    expect(changes.length).toBe(changed);
    const stale = (id: string) =>
      `Refused: the user has written after your answer to message "${shortId("q1")}", so it stays as it is. Answer their latest message with send_to_user and reply_to "${shortId(id)}".`;
    setup([...twoSubThreads(), typed("q3", "Anything else?")]);
    expect(refusalLines(yield* call("replace_send_to_user", q1))).toEqual([
      stale("q3"),
      "The main list shows:",
      "[you] The deploy is done.",
      "[you] Yes, all checks pass.",
      "[user] Anything else?",
    ]);
    setup([...twoSubThreads(), typed("more", "Why?", "a1")]);
    expect(refusalLines(yield* call("replace_send_to_user", q1))).toEqual([
      stale("more"),
      "That message's sub-thread shows:",
      "[you] Yes, all checks pass.",
      "[user] Why?",
    ]);
    // A reply under an ack leaves the answer to send.
    setup([
      typed("q4", "Is the build green?"),
      ackOf("k4", "Checking.", "q4"),
      typed("more", "How long?", "k4"),
    ]);
    const acked = { ...q1, reply_to: shortId("q4"), old_text: "Checking." };
    expect(refusalLines(yield* call("replace_send_to_user", acked))[0]).toBe(
      `Refused: the user has written after your ack for message "${shortId("q4")}", so it stays as it is. Send your answer to "${shortId("q4")}" with send_to_user and reply_to "${shortId("q4")}".`,
    );
    // `/compact` is not a later message: the ack still becomes the answer.
    setup([
      typed("q5", "Is the build green?"),
      ackOf("k5", "Checking.", "q5"),
      typed("c5", "/compact"),
    ]);
    const compacted = { ...q1, reply_to: shortId("q5"), old_text: "Checking." };
    expect((yield* call("replace_send_to_user", compacted)).isError).not.toBe(true);
    setup([...twoSubThreads(), answer("a2", "Lint passes too.", "q2")]);
    const none = refusalLines(
      yield* call("replace_send_to_user", {
        reply_to: shortId("why"),
        user_message: "Which build was deployed?",
        old_text: "Build 20261111.",
        new_text: "Build 20261112.",
      }),
    );
    expect(none[0]).toBe(
      `Refused: you have not answered message "${shortId("why")}", so there is nothing to replace. Use send_to_user.`,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "replaces the agent's own new message only until the user writes after it or replies under it",
  () =>
    Effect.gen(function* () {
      setup([
        typed("q1", "Is the build green?"),
        news("n1", "The deploy is done."),
        news("n2", "CI is red."),
      ]);
      const replaced = yield* call("replace_send_to_user", {
        sub_thread: shortId("The deploy is done."),
        user_message: "",
        old_text: "The deploy is done.",
        new_text: "The deploy is done and checked.",
      });
      expect(replaced.structuredContent).toEqual(shown("Shown to the user."));
      const unknown = refusalLines(
        yield* call("replace_send_to_user", {
          sub_thread: "ffffff",
          user_message: "",
          old_text: "The deploy is done.",
          new_text: "x",
        }),
      );
      expect(unknown).toEqual([
        'Refused: none of your messages sent with new_sub_thread has the id "ffffff".',
        "Your messages sent with new_sub_thread that you may still change, by id:",
        `"${shortId("The deploy is done.")}": The deploy is done.`,
        `"${shortId("CI is red.")}": CI is red.`,
      ]);
      const news1 = {
        sub_thread: shortId("The deploy is done."),
        user_message: "",
        old_text: "The deploy is done.",
        new_text: "x",
      };
      const written = (id: string) =>
        `Refused: the user has written after this message, so it stays as it is. Answer their latest message with send_to_user and reply_to "${shortId(id)}".`;
      setup([news("n1", "The deploy is done."), typed("why", "Which build?", "n1")]);
      expect(refusalLines(yield* call("replace_send_to_user", news1))[0]).toBe(written("why"));
      setup([news("n1", "The deploy is done."), typed("q2", "Anything else?")]);
      expect(refusalLines(yield* call("replace_send_to_user", news1))[0]).toBe(written("q2"));
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses a replace that names both or neither", () =>
  Effect.gen(function* () {
    setup(twoSubThreads());
    const lines = refusalLines(
      yield* call("replace_send_to_user", { user_message: "", old_text: "a", new_text: "b" }),
    );
    expect(lines[0]).toBe(
      "Refused: this thread is in Chat mode. Pass reply_to to replace your answer to that message from the user, or sub_thread to replace a message that you sent with new_sub_thread, and not both.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("gives two user messages with one short id an answer each", () =>
  Effect.gen(function* () {
    // Both ids hash to "003d88".
    const [early, late] = ["message-11914", "message-20610"] as const;
    expect(shortId(early)).toBe(shortId(late));
    // The answer to the earlier one is not stored yet: its hold is that message's, not the id's.
    setup([typed(early, "First?")]);
    const first = { text: "One.", reply_to: shortId(early), user_message: "First?" };
    expect((yield* call("send_to_user", first)).isError).not.toBe(true);
    setup([typed(early, "First?"), answer("a1", "One.", early), typed(late, "Second?")]);
    const args = { text: "Two.", reply_to: shortId(late), user_message: "Second?" };
    expect((yield* call("send_to_user", args)).isError).not.toBe(true);
    setup([...history, answer("a2", "Two.", late)]);
    expect(refusalLines(yield* call("send_to_user", args))[0]).toContain("you already answered");
    const replaced = yield* call("replace_send_to_user", {
      reply_to: shortId(late),
      user_message: "Second?",
      old_text: "Two.",
      new_text: "Two, in short.",
    });
    expect(replaced.isError).not.toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a replace while the answer after an ack is still being delivered", () =>
  Effect.gen(function* () {
    setup([
      ...twoSubThreads(),
      ackOf("k2", "Checking.", "q2"),
      { ...answer("a2", "Lint passes too.", "q2"), status: "running" as const },
    ]);
    const replaced = yield* call(
      "replace_send_to_user",
      {
        reply_to: shortId("q2"),
        user_message: "And the lint job?",
        old_text: "Checking.",
        new_text: "Lint and types pass.",
      },
      repliesThread,
      "r2",
    );
    expect(refusalLines(replaced)[0]).toBe(
      `Refused: your message for message "${shortId("q2")}" is still being delivered. Call replace_send_to_user with reply_to "${shortId("q2")}" again.`,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("judges a named call by the history before it, and a replace by messages since", () =>
  Effect.gen(function* () {
    const running = (id: string, tool: string, input: Record<string, unknown>) =>
      ({ ...sent(id, input), toolName: `mcp__t3-code__${tool}`, status: "running" }) as const;
    // The user wrote while the call ran: the send answers the message that the agent saw.
    const sendArgs = {
      text: "Yes.",
      reply_to: shortId("q1"),
      user_message: "Is the build green?",
    };
    setup([
      typed("q1", "Is the build green?"),
      running("s1", "send_to_user", sendArgs),
      typed("q2", "And the lint job?"),
    ]);
    expect((yield* call("send_to_user", sendArgs, repliesThread, "s1")).isError).not.toBe(true);
    // A replace is refused: the user's message was written after the answer as it was.
    const replaceArgs = {
      reply_to: shortId("q1"),
      user_message: "Is the build green?",
      old_text: "Yes.",
      new_text: "No.",
    };
    const replacing = [
      typed("q1", "Is the build green?"),
      answer("a1", "Yes.", "q1"),
      running("r1", "replace_send_to_user", replaceArgs),
    ];
    for (const under of [undefined, "a1"]) {
      setup([...replacing, typed("q2", "And the lint job?", under)]);
      expect(
        refusalLines(yield* call("replace_send_to_user", replaceArgs, repliesThread, "r1"))[0],
      ).toContain("the user has written after your answer");
    }
    // A reply that old history put under the question is not after the answer in its place.
    setup([...replacing, typed("q2", "And the lint job?", "q1")]);
    expect(
      (yield* call("replace_send_to_user", replaceArgs, repliesThread, "r1")).isError,
    ).not.toBe(true);
    const firstArgs = {
      sub_thread: shortId("The deploy is done."),
      user_message: "",
      old_text: "The deploy is done.",
      new_text: "Done.",
    };
    setup([
      news("n1", "The deploy is done."),
      running("r2", "replace_send_to_user", firstArgs),
      typed("why", "Which build was deployed?", "n1"),
    ]);
    expect(
      refusalLines(yield* call("replace_send_to_user", firstArgs, repliesThread, "r2"))[0],
    ).toContain("the user has written after this message");
  }).pipe(Effect.provide(layer)),
);
