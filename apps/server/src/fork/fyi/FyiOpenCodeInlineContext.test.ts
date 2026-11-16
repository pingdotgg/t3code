import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "@t3tools/provider-opencode/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { openCode2ReplayRuntime } from "../../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:opencode2-adapter");
const TITLE = "Prime check";
const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const runtimePolicy = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  cwd: WORK,
};
const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
const event = (type: string, data: Record<string, unknown>): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: {
      id: `evt_${type.replaceAll(".", "")}0000`,
      created: 1,
      type,
      data,
      durable: { aggregateID: SESSION, seq: 1, version: 1 },
    },
  },
});

const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};
const sessionInfo = {
  id: SESSION,
  title: TITLE,
  permissions: [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules],
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
};

const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

it.layer(McpProviderSessions.layer)("OpenCode2 adapter inline context", (it) => {
  it.effect("loads no $skill that only the turn's inline context names", () =>
    Effect.gen(function* () {
      const prompts: Array<unknown> = [];
      const runtime = yield* openCode2ReplayRuntime(
        [
          out("event.subscribe"),
          out("model.list", "<any>"),
          reply("model.list", modelCatalog),
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo),
          out("permission.list", { sessionID: SESSION }),
          replyData("permission.list", []),
          out("session.form.list", { sessionID: SESSION }),
          replyData("session.form.list", []),
          out("session.instructions.entry.put", {
            sessionID: SESSION,
            key: "t3-code",
            value: "<any>",
          }),
          reply("session.instructions.entry.put", null),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          replyData("session.prompt", {
            id: "msg_0eb735d41001NJee1EvVePJAK5",
            sessionID: SESSION,
            time: { created: 1790656601410 },
            type: "user",
            payload: { text: "hi" },
            delivery: "steer",
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { onPrompt: (input) => prompts.push(input) },
      );
      const now = yield* DateTime.now;
      const thread = yield* runtime.resumeThread({
        providerThread: {
          id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
          driver: OPENCODE_PROVIDER,
          providerInstanceId: instanceId,
          providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
        threadId,
        modelSelection: bigPickle,
        runtimePolicy,
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const text = "<fyi>Run $greet before you ship.</fyi>\n\nUser message:\nsay hi";
      yield* runtime.startTurn({
        appThread: { title: TITLE } as OrchestrationV2AppThread,
        threadId,
        runId: RunId.make("run:opencode2-adapter"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
        rootNodeId: NodeId.make("node:opencode2-adapter"),
        providerThread: thread,
        message: {
          messageId: MessageId.make("message:opencode2-adapter"),
          text,
          attachments: [],
          createdBy: "user" as const,
          creationSource: "web" as const,
          scheduledTaskId: undefined,
          senderThreadId: undefined,
        },
        modelSelection: bigPickle,
        runtimePolicy,
        inlineContextLength: text.length - "say hi".length,
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      assert.notProperty(prompts[0], "skills");
    }),
  );
});
