import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { shortId } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { McpSchema, McpServer, Tool } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { MessageToolkit } from "../../mcp/toolkits/message/tools.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DisplayModeWrap } from "../displayModeWrap/DisplayModeWrap.ts";
import * as SendToUser from "./SendToUser.ts";

const normalThread = ThreadId.make("send-to-user-thread");
const chatThread = ThreadId.make("send-to-user-thread:chat");

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("send-to-user-environment"),
  requestNamespace: "send-to-user-session",
  thread: {
    threadId,
    providerSessionId: "send-to-user-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(),
});
const threadScope = scopeFor(normalThread);
const clientWith = (toolUseId?: string) =>
  McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "send-to-user", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "send-to-user", version: "1" },
    },
    ...(toolUseId === undefined ? {} : { requestMetadata: { "claudecode/toolUseId": toolUseId } }),
    getClient: Effect.die("unused"),
  });

const time = DateTime.makeUnsafe("2026-11-07T00:00:00.000Z");
let ordinal = 0;
const base = (id: string, status: OrchestrationV2TurnItem["status"] = "completed") => ({
  id: TurnItemId.make(id),
  threadId: chatThread,
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
  status,
  title: null,
  startedAt: time,
  completedAt: time,
  updatedAt: time,
});
const typed = (id: string, text: string, creationSource: "web" | "server" = "web") =>
  ({
    ...base(id),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource,
  }) satisfies OrchestrationV2TurnItem;
/** The agent's answer to the user message `to`. */
const answer = (
  id: string,
  text: string,
  to: string,
  status: OrchestrationV2TurnItem["status"] = "completed",
) =>
  ({
    ...base(id, status),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input: { text, reply_to: shortId(to), user_message: "" },
  }) satisfies OrchestrationV2TurnItem;
const rewritten = (id: string, text: string, to: string) =>
  ({
    ...base(id),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__replace_send_to_user",
    input: { reply_to: shortId(to), user_message: "", old_text: "", new_text: text },
  }) satisfies OrchestrationV2TurnItem;

/** The shown history that each thread's reader returns, oldest first. */
let history: ReadonlyArray<OrchestrationV2TurnItem> = [];

const layer = McpHttpServer.toolkitRegistration(
  SendToUser.SendToUserToolkit,
  SendToUser.layerHandlers,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    ServerSettings.layerTest({
      threadDisplayModes: { [chatThread]: "chat-replies" },
    }),
  ),
  Layer.provide(
    Layer.mock(DisplayModeWrap)({
      latestShownItems: () => Effect.succeed(history),
      forgetNotesAfterCompaction: () => (ingest) => ingest,
    }),
  ),
);

const call = (
  name: "send_to_user" | "replace_send_to_user",
  args: Record<string, unknown>,
  options: { readonly threadId?: ThreadId; readonly toolUseId?: string } = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      scopeFor(options.threadId ?? chatThread),
    ),
    Effect.provideService(McpSchema.McpServerClient, clientWith(options.toolUseId)),
  );

const send = (text: string, scope: McpInvocationContext.McpInvocationScope = threadScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "send_to_user", arguments: { text } })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, clientWith()),
  );

/** The text of a refused call, which the agent reads. */
const refusalText = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

const SHOWN = {
  ok: true,
  message: "Shown to the user. If you are done, end your turn with no text.",
};
/** Normal mode answers as upstream's send_to_user, and gives web and mobile the text to draw. */
const shownInNormal = (text: string) => ({
  ok: true,
  message: "Shown to the user. Don't repeat it.",
  sentMessage: text,
});
/** Answers the user message u1, "Fix the build.", in Chat mode. */
const answerU1 = (text: string, more: Record<string, unknown> = {}) =>
  call("send_to_user", { text, reply_to: shortId("u1"), user_message: "Fix the build.", ...more });

it.effect("shows the message to the user without needing any capability", () =>
  Effect.gen(function* () {
    const result = yield* send("The tests pass.");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(shownInNormal("The tests pass."));
  }).pipe(Effect.provide(layer)),
);

// The allowlist, ToolSearch and plan mode treat the registered send_to_user by upstream's annotations.
it("annotates send_to_user as upstream's send_to_user", () => {
  const annotations = (tool: Tool.Any) => [
    ...[Tool.Readonly, Tool.Destructive, Tool.Idempotent, Tool.OpenWorld].map((key) =>
      Context.get(tool.annotations, key),
    ),
    Context.getOption(tool.annotations, Tool.Meta),
  ];
  expect(annotations(SendToUser.SendToUserToolkit.tools.send_to_user)).toEqual(
    annotations(MessageToolkit.tools.send_to_user),
  );
});

it.effect("refuses a caller outside a thread", () =>
  Effect.gen(function* () {
    const result = yield* send("Hello", { ...threadScope, thread: undefined });
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(layer)),
);

describe("the 1000-byte limit", () => {
  const ONE_POINT = "only say one concise point at a time";
  const oversize = "a".repeat(1_001);
  const replaceWith = (
    new_text: string,
    options: { readonly threadId?: ThreadId; readonly old_text?: string } = {},
  ) =>
    call(
      "replace_send_to_user",
      {
        reply_to: shortId("u1"),
        user_message: "Fix the build.",
        old_text: options.old_text ?? "On it.",
        new_text,
      },
      { threadId: options.threadId ?? chatThread },
    );
  /** The parts of a result the agent reads. */
  const seen = (result: McpSchema.CallToolResult) => ({
    isError: result.isError,
    content: result.content,
    structuredContent: result.structuredContent,
  });
  const REFUSED = {
    isError: true,
    content: [{ type: "text", text: ONE_POINT }],
    structuredContent: undefined,
  };

  it.effect("refuses an oversize send with only the sentence", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build.")];
      expect(seen(yield* answerU1(oversize))).toEqual(REFUSED);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an oversize new_text with only the sentence", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), answer("s1", "On it.", "u1")];
      expect(seen(yield* replaceWith(oversize))).toEqual(REFUSED);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each<readonly [string, string]>([
    ["ASCII letters", "a".repeat(1_000)],
    ["backslashes", "\\".repeat(500)],
    ["line breaks", "\n".repeat(500)],
    ["quotes", '"'.repeat(500)],
    ["Chinese characters", "汉".repeat(333) + "a"],
    ["control characters", "\u0001".repeat(166) + "aaaa"],
    ["emoji", "😀".repeat(250)],
  ])("shows 1000 bytes of %s and refuses one byte more", ([_name, atLimit]) =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build.")];
      expect((yield* answerU1(atLimit)).isError).not.toBe(true);
      expect(refusalText(yield* answerU1(`${atLimit}a`))).toBe(ONE_POINT);
      history = [typed("u1", "Fix the build."), answer("s1", "On it.", "u1")];
      expect((yield* replaceWith(atLimit)).structuredContent).toEqual(SHOWN);
      expect(refusalText(yield* replaceWith(`${atLimit}a`))).toBe(ONE_POINT);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shows an ack of 200 bytes and refuses one byte more, outside Normal", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build.")];
      expect(refusalText(yield* answerU1("a".repeat(201), { ack: true }))).toBe(
        "an ack is at most 200 bytes. Say only that you got the message and are on it.",
      );
      expect((yield* answerU1("a".repeat(200), { ack: true })).isError).not.toBe(true);
      expect((yield* answerU1("a".repeat(1_000))).isError).not.toBe(true);
      const normal = yield* call(
        "send_to_user",
        { text: "a".repeat(201), ack: true },
        { threadId: normalThread },
      );
      expect(normal.structuredContent).toEqual(shownInNormal("a".repeat(201)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each<readonly [string, string]>([
    ["ASCII letters", "a".repeat(4_000)],
    ["Chinese characters", "界".repeat(4_000)],
    ["emoji", "😀".repeat(2_000)],
  ])("shows 4000 UTF-16 code units of %s in Normal and refuses one more", ([_name, atLimit]) =>
    Effect.gen(function* () {
      const normal = (text: string) => call("send_to_user", { text }, { threadId: normalThread });
      expect((yield* normal(atLimit)).structuredContent).toEqual(shownInNormal(atLimit));
      expect(refusalText(yield* normal(`${atLimit}a`))).toBe(
        "a message is at most 4000 UTF-16 code units; send the rest in another message.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an oversize new_text before the replace's other refusals", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), answer("s1", "On it.", "u1")];
      const normal = yield* replaceWith(oversize, { threadId: normalThread });
      expect(refusalText(normal)).toBe(ONE_POINT);
      const unlike = yield* replaceWith(oversize, { old_text: "Something else entirely." });
      expect(refusalText(unlike)).toBe(ONE_POINT);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not hold the answer for a refused unnamed send", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build.")];
      expect((yield* answerU1(oversize)).isError).toBe(true);
      expect((yield* answerU1("Done.")).isError).not.toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each<readonly [string, OrchestrationV2TurnItem]>([
    ["failed", answer("refused", oversize, "u1", "failed")],
    [
      "completed with an error result",
      {
        ...answer("refused", oversize, "u1"),
        output: { content: [{ type: "text", text: ONE_POINT }], isError: true },
      },
    ],
  ])("does not count a refused send stored as %s", ([_name, refused]) =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), refused];
      const named = yield* call(
        "send_to_user",
        { text: "Done.", reply_to: shortId("u1"), user_message: "Fix the build." },
        { toolUseId: "toolu_own" },
      );
      expect(named.isError).not.toBe(true);
      expect((yield* answerU1("Done.")).isError).not.toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("states the limit in the schema, which keeps only the minimum length", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const parameter = (tool: string, name: string) => {
        const schema = server.tools.find((entry) => entry.tool.name === tool)?.tool.inputSchema as
          | { readonly properties: Record<string, Record<string, unknown>> }
          | undefined;
        return schema?.properties[name];
      };
      for (const schema of [
        parameter("send_to_user", "text"),
        parameter("replace_send_to_user", "new_text"),
      ]) {
        expect(schema).toMatchObject({ minLength: 1 });
        expect(schema).not.toHaveProperty("maxLength");
        expect(schema?.description).toContain("1000 bytes of UTF-8 after JSON escaping");
        expect(schema?.description).toContain("a longer text is refused and not shown");
      }
      expect(parameter("send_to_user", "text")?.description).toContain(
        "In any other thread (the full view, Normal): at most 4000 UTF-16 code units",
      );
      const empty = yield* call("send_to_user", { text: "" }).pipe(Effect.exit);
      expect(Exit.isFailure(empty)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});

describe("replace_send_to_user", () => {
  const replace = (user_message: string, old_text: string, threadId = chatThread) =>
    call(
      "replace_send_to_user",
      { reply_to: shortId("u1"), user_message, old_text, new_text: "Done, and pushed." },
      { threadId },
    );

  it.effect("accepts the user's message and the current answer as the recap shows them", () =>
    Effect.gen(function* () {
      const long = "汉".repeat(700);
      history = [typed("u1", long), answer("s1", "On it.", "u1")];
      const result = yield* replace(`[user] ${"汉".repeat(666)}…[truncated]`, "[you] On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("compares old_text with the answer's text after its earlier rewrites", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        answer(
          "s1",
          "The build passed on prototype/host. I will deploy after Chief says yes.",
          "u1",
        ),
        rewritten("w1", "Deployed. Next I clean up the old branches.", "u1"),
      ];
      const stale = refusalText(
        yield* replace(
          "Fix the build.",
          "The build passed on prototype/host. I will deploy after Chief says yes.",
        ),
      );
      expect(stale).toMatch(/^Refused: old_text is \d+% like your answer to it; needs 70%\./);
      const current = yield* replace("Fix the build.", "Deployed; next I clean up old branches.");
      expect(current.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("matches the user's message in the form the agent got, with quote placeholders", () =>
    Effect.gen(function* () {
      const quote = serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        text: "a long quoted sentence about the deploy order and the rollback plan",
        start: 0,
        end: 10,
        prefix: "",
        suffix: "",
      });
      history = [typed("u1", `Why ${quote}?`), answer("s1", "On it.", "u1")];
      const result = yield* replace("Why [assistant-quote-1]?", "On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "accepts a message copied whole a little over 2000 bytes, comparing its first 2000",
    () =>
      Effect.gen(function* () {
        const long = "Fix the build and tell me what broke. ".repeat(65);
        history = [typed("u1", long), answer("s1", "On it.", "u1")];
        const result = yield* replace(long, "On it.");
        expect(result.structuredContent).toEqual(SHOWN);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses user_message and old_text over 2500 bytes once JSON-escaped", () =>
    Effect.gen(function* () {
      const typedText = "\\".repeat(1_250);
      const sentText = "a".repeat(2_500);
      history = [typed("u1", typedText), answer("s1", sentText, "u1")];
      const within = yield* replace(typedText, sentText);
      expect(within.structuredContent).toEqual(SHOWN);
      const user = yield* replace(`${typedText}\\`, sentText).pipe(Effect.flip);
      const old = yield* replace(typedText, `${sentText}a`).pipe(Effect.flip);
      expect([user.message, old.message]).toEqual([
        expect.stringContaining("Over 2000 bytes of UTF-8 once JSON-escaped"),
        expect.stringContaining("Over 2000 bytes of UTF-8 once JSON-escaped"),
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses in Normal", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), answer("s1", "On it.", "u1")];
      expect(refusalText(yield* replace("Fix the build.", "On it.", normalThread))).toBe(
        "Refused: replace_send_to_user works only in a thread set to Chat mode. Use send_to_user.",
      );
    }).pipe(Effect.provide(layer)),
  );
});
