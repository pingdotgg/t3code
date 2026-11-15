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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Context from "effect/Context";
import { McpSchema, McpServer, Tool } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { MessageToolkit } from "../../mcp/toolkits/message/tools.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DisplayModeWrap } from "../displayModeWrap/DisplayModeWrap.ts";
import * as SendToUser from "./SendToUser.ts";

const normalThread = ThreadId.make("send-to-user-thread");
const messagesThread = ThreadId.make("send-to-user-thread:messages-only");
const dashboardThread = ThreadId.make("send-to-user-thread:messages-dashboard");

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
  threadId: messagesThread,
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
const sent = (id: string, text: string, status: OrchestrationV2TurnItem["status"] = "completed") =>
  ({
    ...base(id, status),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input: { text },
  }) satisfies OrchestrationV2TurnItem;
const acked = (id: string, text: string, status: OrchestrationV2TurnItem["status"] = "completed") =>
  ({ ...sent(id, text, status), input: { text, ack: true } }) satisfies OrchestrationV2TurnItem;
const rewritten = (id: string, text: string) =>
  ({
    ...base(id),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__replace_send_to_user",
    input: { user_message: "", old_text: "", new_text: text },
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
      threadDisplayModes: {
        [messagesThread]: "messages-only",
        [dashboardThread]: "messages-dashboard",
      },
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
      scopeFor(options.threadId ?? messagesThread),
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
const ACKED = {
  ok: true,
  message: "Shown to the user as an ack. Send your answer when it is ready.",
};
const SECOND_ANSWER =
  "Refused: you already answered the user's last message. To change your answer, call replace_send_to_user.";
const SECOND_ACK =
  "Refused: you already sent an ack for the user's last message. Send your answer without ack, or make the ack your answer with replace_send_to_user.";
const LATE_ACK =
  "Refused: you already answered the user's last message, and an ack goes only before the answer. To change your answer, call replace_send_to_user.";
const DELIVERING =
  "Refused: your message for the user's last message is still being delivered. Call replace_send_to_user again.";
/** The first line of a refusal: its reason. */
const reasonOf = (result: McpSchema.CallToolResult) => refusalText(result).split("\n")[0];

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
      { user_message: "Fix the build.", old_text: options.old_text ?? "On it.", new_text },
      { threadId: options.threadId ?? messagesThread },
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
      history = [typed("u1", "Fix the build."), sent("s1", "On it."), typed("u2", "Any news?")];
      expect(seen(yield* call("send_to_user", { text: oversize }))).toEqual(REFUSED);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an oversize new_text with only the sentence", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
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
      expect((yield* call("send_to_user", { text: atLimit })).structuredContent).toEqual(SHOWN);
      expect(refusalText(yield* call("send_to_user", { text: `${atLimit}a` }))).toBe(ONE_POINT);
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      expect((yield* replaceWith(atLimit)).structuredContent).toEqual(SHOWN);
      expect(refusalText(yield* replaceWith(`${atLimit}a`))).toBe(ONE_POINT);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shows an ack of 200 bytes and refuses one byte more, outside Normal", () =>
    Effect.gen(function* () {
      const ack = (text: string, threadId: ThreadId) =>
        call("send_to_user", { text, ack: true }, { threadId });
      for (const threadId of [messagesThread, dashboardThread]) {
        history = [typed("u1", "Fix the build.")];
        expect(refusalText(yield* ack("a".repeat(201), threadId))).toBe(
          "an ack is at most 200 bytes. Say only that you got the message and are on it.",
        );
        expect((yield* ack("a".repeat(200), threadId)).isError).not.toBe(true);
      }
      const answer = yield* call("send_to_user", { text: "a".repeat(1_000) });
      expect(answer.structuredContent).toEqual(SHOWN);
      const normal = yield* ack("a".repeat(201), normalThread);
      expect(normal.structuredContent).toEqual(shownInNormal("a".repeat(201)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an oversize send in Messages only and Messages + Dashboard", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build.")];
      for (const threadId of [messagesThread, dashboardThread]) {
        expect(seen(yield* call("send_to_user", { text: oversize }, { threadId }))).toEqual(
          REFUSED,
        );
      }
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
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      const normal = yield* replaceWith(oversize, { threadId: normalThread });
      expect(refusalText(normal)).toBe(ONE_POINT);
      const unlike = yield* replaceWith(oversize, { old_text: "Something else entirely." });
      expect(refusalText(unlike)).toBe(ONE_POINT);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not hold the one send for a refused unnamed send", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build.")];
      expect((yield* call("send_to_user", { text: oversize })).isError).toBe(true);
      expect((yield* call("send_to_user", { text: "Done." })).structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each<readonly [string, OrchestrationV2TurnItem]>([
    ["failed", sent("refused", oversize, "failed")],
    [
      "completed with an error result",
      {
        ...sent("refused", oversize),
        output: { content: [{ type: "text", text: ONE_POINT }], isError: true },
      },
    ],
  ])("does not count a refused send stored as %s", ([_name, refused]) =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), refused];
      const named = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(named.structuredContent).toEqual(SHOWN);
      const unnamed = yield* call("send_to_user", { text: "Done." });
      expect(unnamed.structuredContent).toEqual(SHOWN);
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

describe("one send per typed message", () => {
  it.effect("shows the first send after the user's message, as sends before it do not count", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it."), typed("u2", "Any news?")];
      const result = yield* call("send_to_user", { text: "Done." });
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a second send with the latest messages and the current one", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("s1", "On it."),
        typed("u2", "Any news?"),
        typed("r", "Continue where you left off.", "server"),
        sent("s2", "Still working."),
        rewritten("w2", "Still working, halfway."),
      ];
      const error = refusalText(yield* call("send_to_user", { text: "Done." }));
      expect(error).toBe(
        [
          SECOND_ANSWER,
          "Latest messages between you and the user:",
          "[you] On it.",
          "[user] Any news?",
          "[you] Still working, halfway.",
          "Your current message, as old_text:",
          "Still working, halfway.",
        ].join("\n"),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts a send made in Normal as an answer, though it passed ack", () =>
    Effect.gen(function* () {
      const inNormal = {
        ...acked("n1", "On it."),
        output: shownInNormal("On it."),
      } satisfies OrchestrationV2TurnItem;
      history = [typed("u1", "Fix the build."), inNormal];
      expect(reasonOf(yield* call("send_to_user", { text: "Done." }))).toBe(SECOND_ANSWER);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("takes one ack before the answer, and no send after the answer", () =>
    Effect.gen(function* () {
      const named = (text: string, ack = false) =>
        call("send_to_user", { text, ack }, { toolUseId: "toolu_own" });
      history = [typed("u1", "Fix the build.")];
      expect((yield* named("On it.", true)).structuredContent).toEqual(ACKED);
      history = [typed("u1", "Fix the build."), acked("a1", "On it.")];
      expect(reasonOf(yield* named("Still on it.", true))).toBe(SECOND_ACK);
      expect((yield* named("Done.")).structuredContent).toEqual(SHOWN);
      for (const answered of [sent("s1", "Done."), rewritten("w1", "Done.")]) {
        history = [typed("u1", "Fix the build."), acked("a1", "On it."), answered];
        expect(reasonOf(yield* named("Also: types pass."))).toBe(SECOND_ANSWER);
        expect(reasonOf(yield* named("On it.", true))).toBe(LATE_ACK);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("limits Messages + Dashboard too, and not Normal", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      const dashboard = yield* call(
        "send_to_user",
        { text: "Done." },
        { threadId: dashboardThread },
      );
      expect(dashboard.isError).toBe(true);
      const normal = yield* call("send_to_user", { text: "Done." }, { threadId: normalThread });
      expect(normal.structuredContent).toEqual(shownInNormal("Done."));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts another send still running when the call names its own tool use", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("other", "On it.", "running")];
      const refused = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(refused.isError).toBe(true);
      history = [typed("u1", "Fix the build."), sent("own", "Done.", "running")];
      const own = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(own.structuredContent).toEqual(SHOWN);
      history = [typed("u1", "Fix the build."), sent("other", "On it.", "failed")];
      const failed = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(failed.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("of two sends in one response, shows the first and refuses the second", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("first", "On it.", "running"),
        sent("second", "Done.", "running"),
      ];
      const first = yield* call("send_to_user", { text: "On it." }, { toolUseId: "toolu_first" });
      expect(first.structuredContent).toEqual(SHOWN);
      const second = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_second" });
      expect(second.isError).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores a message the user typed after the call started", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("own", "Done.", "running"),
        typed("u2", "Also run the tests."),
        sent("later", "Tests pass.", "completed"),
      ];
      const result = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "of two unnamed sends before either is stored, refuses the second for a few seconds",
    () =>
      Effect.gen(function* () {
        history = [typed("u1", "Fix the build.")];
        const first = yield* call("send_to_user", { text: "On it." });
        expect(first.structuredContent).toEqual(SHOWN);
        const second = yield* call("send_to_user", { text: "Done." });
        expect(second.isError).toBe(true);
        yield* TestClock.adjust("11 seconds");
        const later = yield* call("send_to_user", { text: "Done." });
        expect(later.structuredContent).toEqual(SHOWN);
        history = [typed("u1", "Fix the build."), sent("s1", "Done."), typed("u2", "Thanks.")];
        const afterTyping = yield* call("send_to_user", { text: "You're welcome." });
        expect(afterTyping.structuredContent).toEqual(SHOWN);
        history = [typed("u3", "Ship it.")];
        const ack = yield* call("send_to_user", { text: "On it.", ack: true });
        expect(ack.structuredContent).toEqual(ACKED);
        expect(reasonOf(yield* call("send_to_user", { text: "On it.", ack: true }))).toBe(
          SECOND_ACK,
        );
        const answer = yield* call("send_to_user", { text: "Shipped." });
        expect(answer.structuredContent).toEqual(SHOWN);
        expect(reasonOf(yield* call("send_to_user", { text: "Tagged too." }))).toBe(SECOND_ANSWER);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("counts only completed sends when the call does not name its tool use", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("other", "On it.", "running")];
      const result = yield* call("send_to_user", { text: "Done." });
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );
});

describe("replace_send_to_user", () => {
  const replace = (user_message: string, old_text: string, threadId = messagesThread) =>
    call(
      "replace_send_to_user",
      { user_message, old_text, new_text: "Done, and pushed." },
      {
        threadId,
      },
    );

  it.effect("accepts the user's message and the current message as the recap shows them", () =>
    Effect.gen(function* () {
      const long = "汉".repeat(700);
      history = [typed("u1", long), sent("s1", "On it.")];
      const result = yield* replace(`[user] ${"汉".repeat(666)}…[truncated]`, "[you] On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("compares old_text with the send's text after its earlier rewrites", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("s1", "The build passed on prototype/host. I will deploy after Chief says yes."),
        rewritten("w1", "Deployed. Next I clean up the old branches."),
      ];
      const stale = refusalText(
        yield* replace(
          "Fix the build.",
          "The build passed on prototype/host. I will deploy after Chief says yes.",
        ),
      );
      expect(stale).toMatch(/^Refused: old_text is \d+% like your current message; needs 70%\./);
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
      history = [typed("u1", `Why ${quote}?`), sent("s1", "On it.")];
      const result = yield* replace("Why [assistant-quote-1]?", "On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a user_message unlike the user's last message, floored to whole percent", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      // The longest common subsequence is "i the l.", 8 characters, against 14 + 17: 51.6%.
      const error = refusalText(yield* replace("Ship the release.", "On it."));
      expect(error.split("\n")[0]).toBe(
        "Refused: user_message is 51% like the user's last message; needs 70%.",
      );
      expect(error).toContain("[user] Fix the build.\n[you] On it.");
      expect(error.endsWith("Your current message, as old_text:\nOn it.")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "expects an empty user_message, and refuses an ack, when the user has typed nothing",
    () =>
      Effect.gen(function* () {
        history = [typed("r", "Continue where you left off.", "server")];
        expect(reasonOf(yield* call("send_to_user", { text: "On it.", ack: true }))).toBe(
          "Refused: an ack answers a message from the user, and they have typed none. Send without ack.",
        );
        expect((yield* call("send_to_user", { text: "On it." })).structuredContent).toEqual(SHOWN);
        history = [typed("r", "Continue where you left off.", "server"), sent("s1", "On it.")];
        const error = refusalText(yield* replace("Continue where you left off.", "On it."));
        expect(error.split("\n")[0]).toBe(
          "Refused: user_message is 0% like the user's last message; expected an empty string.",
        );
        const result = yield* replace("", "On it.");
        expect(result.structuredContent).toEqual(SHOWN);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "accepts a message copied whole a little over 2000 bytes, comparing its first 2000",
    () =>
      Effect.gen(function* () {
        const long = "Fix the build and tell me what broke. ".repeat(65);
        history = [typed("u1", long), sent("s1", "On it.")];
        const result = yield* replace(long, "On it.");
        expect(result.structuredContent).toEqual(SHOWN);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses user_message and old_text over 2500 bytes once JSON-escaped", () =>
    Effect.gen(function* () {
      const typedText = "\\".repeat(1_250);
      const sentText = "a".repeat(2_500);
      history = [typed("u1", typedText), sent("s1", sentText)];
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

  it.effect("refuses a replace while the answer after an ack is still being delivered", () =>
    Effect.gen(function* () {
      const replaceAck = (toolUseId?: string) =>
        call(
          "replace_send_to_user",
          { user_message: "Fix the build.", old_text: "On it.", new_text: "Done." },
          toolUseId === undefined ? {} : { toolUseId },
        );
      history = [
        typed("u1", "Fix the build."),
        acked("a1", "On it."),
        sent("s1", "Fixed.", "running"),
      ];
      expect(reasonOf(yield* replaceAck("toolu_own"))).toBe(DELIVERING);
      history = [typed("u1", "Fix the build."), acked("a1", "On it.")];
      expect((yield* call("send_to_user", { text: "Fixed." })).structuredContent).toEqual(SHOWN);
      expect(reasonOf(yield* replaceAck())).toBe(DELIVERING);
      history = [typed("u1", "Fix the build."), acked("a1", "On it."), sent("s1", "Fixed.")];
      const stored = yield* call("replace_send_to_user", {
        user_message: "Fix the build.",
        old_text: "Fixed.",
        new_text: "Fixed and pushed.",
      });
      expect(stored.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("makes an ack the answer, and then holds against another answer", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), acked("a1", "On it.")];
      const replaced = yield* replace("Fix the build.", "On it.");
      expect(replaced.structuredContent).toEqual(SHOWN);
      expect(reasonOf(yield* call("send_to_user", { text: "Done." }))).toBe(SECOND_ANSWER);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("holds a named replace of an ack against another answer until it is stored", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), acked("a1", "On it.")];
      const namedReplace = yield* call(
        "replace_send_to_user",
        { user_message: "Fix the build.", old_text: "On it.", new_text: "Done." },
        { toolUseId: "toolu_replace" },
      );
      expect(namedReplace.structuredContent).toEqual(SHOWN);
      const namedSend = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_send" });
      expect(reasonOf(namedSend)).toBe(SECOND_ANSWER);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses when there is no send since the user's last message", () =>
    Effect.gen(function* () {
      history = [sent("s1", "On it."), typed("u1", "Fix the build.")];
      const error = refusalText(yield* replace("Fix the build.", "On it."));
      expect(error.split("\n")[0]).toBe(
        "Refused: you have sent no message since the user's last one, so there is nothing to replace. Use send_to_user.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses outside Messages only and Messages + Dashboard", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      const error = refusalText(yield* replace("Fix the build.", "On it.", normalThread));
      expect(error.split("\n")[0]).toBe(
        "Refused: replace_send_to_user works only in a thread whose display mode allows one answer from you per message of the user. This thread's mode does not. Use send_to_user.",
      );
      const dashboard = yield* replace("Fix the build.", "On it.", dashboardThread);
      expect(dashboard.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );
});
