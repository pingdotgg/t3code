// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import {
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderOptionDescriptor,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deriveBlockedOnThreadWait } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  ACP_EMPTY_OPTION_VALUE,
  ACP_SESSION_MODE_OPTION_ID,
  acpProviderOptionDescriptors,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  extractXAiAcpSubagentUpdate,
  makeGrokAdapterV2,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
} from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  AcpProviderCapabilitiesV2,
  acpPerTurnPromptUsage,
  acpScopedNativeId,
  acpPostSettleContinuationOfferEvidence,
  acpPostSettleWakeEvidence,
  acpToolCallDiffPatch,
  acpToolCallSnippetEdit,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import { appendUserInputAttachmentPaths } from "../../provider/userInputAttachments.ts";
import { makeGrokAcpAdapterFlavor } from "@t3tools/provider-grok/testing";
import {
  acpRegistryPromptFailure,
  registerMistralVibeAcpExtensions,
} from "@t3tools/provider-acp-registry/testing";

import {
  layerTest,
  ACP_TEST_DRIVER,
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolRequestParam,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.effect("routes interleaved Copilot subagent output into subagent threads", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      let sessionEvent:
        | ((event: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>)
        | undefined;
      const routing = makeCopilotSubagentRouting();
      const instanceId = ProviderInstanceId.make("copilot-replay");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          registerExtensions: routing.registerExtensions,
          normalizeSessionUpdate: routing.normalizeSessionUpdate,
          extractSubagentUpdate: extractCopilotSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              handleExtNotification: (method, payload, next) =>
                Effect.sync(() => {
                  if (method === "github.com/copilot/sessionEvent") {
                    sessionEvent = next as typeof sessionEvent;
                  }
                }).pipe(Effect.andThen(runtime.handleExtNotification(method, payload, next))),
              prompt: () =>
                Effect.gen(function* () {
                  assert.isDefined(handler);
                  assert.isDefined(sessionEvent);
                  const sessionId = "mock-session-1";
                  const raw = (type: string, data: object, agentId?: string) =>
                    sessionEvent!({ sessionId, type, data, ...(agentId ? { agentId } : {}) });
                  const update = (next: EffectAcpSchema.SessionUpdate) =>
                    handler!({ sessionId, update: next });
                  // Copilot sends each chunk's raw delta just before the chunk.
                  const chunk = (text: string, task?: string) =>
                    raw("assistant.message_delta", {
                      deltaContent: text,
                      ...(task ? { parentToolCallId: task } : {}),
                    }).pipe(
                      Effect.andThen(
                        update({
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text },
                        }),
                      ),
                    );
                  const launch = (toolCallId: string, description: string, mode: string) =>
                    update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: description,
                      kind: "other",
                      status: "pending",
                      rawInput: {
                        description,
                        prompt: `${description}.`,
                        agent_type: "explore",
                        mode,
                      },
                    });
                  yield* chunk("Launching ");
                  yield* launch("task-a", "Describe a.txt", "sync");
                  yield* launch("task-b", "Describe b.txt", "sync");
                  yield* launch("task-bg", "List directory", "background");
                  yield* raw("subagent.started", { toolCallId: "task-a" }, "agent-a");
                  yield* raw("subagent.started", { toolCallId: "task-b" }, "agent-b");
                  yield* raw("subagent.started", { toolCallId: "task-bg" }, "agent-bg");
                  yield* update({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "task-bg",
                    status: "completed",
                    rawOutput: { content: "Agent started in background with agent_id: agent-bg." },
                  });
                  yield* update({
                    sessionUpdate: "tool_call",
                    toolCallId: "view-a",
                    title: "Viewing a.txt",
                    kind: "read",
                    status: "completed",
                    rawInput: { path: "a.txt" },
                    _meta: { "github.com/copilot": { agentId: "agent-a" } },
                  });
                  yield* chunk("`a.txt` says", "task-a");
                  yield* chunk("`b.txt` has", "task-b");
                  yield* chunk(" hello.", "task-a");
                  yield* chunk("a.txt b.txt", "task-bg");
                  yield* chunk(" three lines.", "task-b");
                  for (const [task, agent, text] of [
                    ["task-a", "agent-a", "`a.txt` says hello."],
                    ["task-b", "agent-b", "`b.txt` has three lines."],
                  ] as const) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId: task,
                      status: "completed",
                      rawOutput: { content: text },
                    });
                    yield* raw("subagent.completed", { toolCallId: task }, agent);
                  }
                  yield* raw("subagent.completed", { toolCallId: "task-bg" }, "agent-bg");
                  yield* chunk("all done.");
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("copilot-replay-parent");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("copilot-replay-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const lastText = (thread: string | null | undefined) =>
        new Map(
          items.flatMap((item) =>
            item.threadId === thread && item.type === "assistant_message"
              ? [[item.id, item.text] as const]
              : [],
          ),
        );
      assert.deepEqual([...lastText(threadId).values()].join(""), "Launching all done.");
      const tasks = new Map(
        events.flatMap((event) =>
          event.type === "subagent.updated"
            ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent] as const]
            : [],
        ),
      );
      const outputs = Object.fromEntries(
        [...tasks].map(([id, task]) => [
          id,
          [task.status, [...lastText(task.childThreadId).values()].join("")],
        ]),
      );
      assert.deepEqual(outputs, {
        "task-a": ["completed", "`a.txt` says hello."],
        "task-b": ["completed", "`b.txt` has three lines."],
        "task-bg": ["completed", "a.txt b.txt"],
      });
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === tasks.get("task-a")?.childThreadId &&
            item.type === "dynamic_tool" &&
            item.title === "Read a.txt",
        ),
      );
      assert.isFalse(
        items.some((item) => item.threadId === threadId && item.type === "dynamic_tool"),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("keeps protocol diagnostics off unless a protocol logger is supplied", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const runTurn = Effect.fn("AcpAdapterV2.testProtocolLoggingTurn")(function* (
        name: string,
        nativeLogging?: NonNullable<Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"]>,
      ) {
        const events: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
        const instanceId = ProviderInstanceId.make(`acp-test-${name}`);
        const threadId = ThreadId.make(`thread-acp-${name}`);
        const makeRuntime = makeMockRuntime({ childProcessSpawner, mockAgentPath });
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: (runtimeInput) =>
              makeRuntime({
                ...runtimeInput,
                protocolLogging: {
                  ...runtimeInput.protocolLogging,
                  logger: (event) =>
                    Effect.sync(() => void events.push(event)).pipe(
                      Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                    ),
                },
              }),
          },
          selfInvocation,
          ...(nativeLogging === undefined ? {} : { nativeLogging }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`provider-session-acp-${name}`),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal: 1,
          }),
        );
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.equal(Option.getOrThrow(terminal).status, "completed");
        return events;
      });

      assert.deepEqual(yield* runTurn("protocol-logging-default"), []);

      const explicit: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
      yield* runTurn("protocol-logging-explicit", () => ({
        protocolLogging: {
          logIncoming: true,
          logOutgoing: true,
          logger: (event) => Effect.sync(() => void explicit.push(event)),
        },
      }));
      assert.isTrue(explicit.some((e) => e.direction === "incoming" && e.stage === "raw"));
      assert.isTrue(explicit.some((e) => e.direction === "outgoing"));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("advertises ACP session notices and shows them as system notices", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-notice");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: { T3_ACP_EMIT_NOTICE: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-notice");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-notice"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
      );
      const items = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

      const initialize = Array.from(yield* Queue.takeAll(protocolEvents)).find(
        (event) => event.direction === "outgoing" && rawProtocolMethod(event) === "initialize",
      );
      assert.deepEqual(
        initialize === undefined
          ? undefined
          : Reflect.get(
              Object(rawProtocolRequestParam(initialize, "clientCapabilities")),
              "session",
            ),
        { notices: {} },
      );
      const title =
        "skill discovery warning: candidate was skipped because its metadata is invalid";
      assert.deepEqual(
        items.flatMap((item) => (item.type === "system_notice" ? [item.message] : [])),
        [title],
      );
      const replies = new Map(
        items.flatMap((item) => (item.type === "assistant_message" ? [[item.id, item.text]] : [])),
      );
      assert.deepEqual(
        [...replies.values()],
        ["before the notice, after the notice"],
        "a notice neither joins the reply nor splits it",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("projects ACP v2 fidelity updates into first-class orchestration items", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-v2-fidelity");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_V2_FIDELITY: "1" },
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-v2-fidelity");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-v2-fidelity"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 1,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const plans = events.flatMap((event) => (event.type === "plan.updated" ? [event.plan] : []));
      const planA = plans.filter((plan) => plan.kind === "proposed_plan");
      const planB = plans.find((plan) => plan.kind === "todo_list");
      assert.equal(planA.length, 2);
      assert.equal(planA[0]?.id, planA[1]?.id);
      assert.equal(planA[1]?.status, "superseded");
      assert.isDefined(planB);
      assert.notEqual(planA[0]?.id, planB?.id);
      const planC = plans.find(
        (plan) =>
          plan.kind === "todo_list" && plan.steps.some((step) => step.text === "Write the fix"),
      );
      assert.ok(planC?.kind === "todo_list");
      assert.deepEqual(
        planC.steps.map((step) => ({ id: step.id, text: step.text, status: step.status })),
        [
          { id: "acp-step-1", text: "Write the fix", status: "completed" },
          { id: "acp-step-3", text: "Add a test", status: "completed" },
        ],
      );
      assert.equal(planC.status, "completed");

      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      assert.isFalse(
        items.some((item) => item.type === "user_message" && item.text === "stale user text"),
        "the active ACP prompt echo must not create a second user message",
      );
      assert.isTrue(items.some((item) => item.type === "user_message" && item.text.length === 0));
      assert.equal(
        items.filter((item) => item.type === "assistant_message").at(-1)?.text,
        "authoritative answer",
      );
      assert.isTrue(
        items.some((item) => item.type === "reasoning" && item.text === "final thought"),
      );
      assert.deepInclude(
        items.flatMap((item) =>
          item.type === "command_execution" ? [{ input: item.input, output: item.output }] : [],
        ),
        { input: "printf proof", output: "proof" },
      );
      assert.deepInclude(
        items.flatMap((item) =>
          item.type === "command_execution" ? [{ input: item.input, output: item.output }] : [],
        ),
        { input: "cat probe.txt", output: "after\n" },
      );
      assert.isTrue(
        items.some((item) => item.title === "Action required" && item.status === "waiting"),
      );
      assert.isTrue(
        items.some(
          (item) =>
            item.type === "file_change" &&
            item.changes?.[0]?.operation === "move" &&
            item.changes[0]?.oldPath === "/workspace/old.ts",
        ),
      );
      const read = items.find((item) => item.type === "dynamic_tool" && item.toolName === "Read");
      assert.deepEqual(
        read?.type === "dynamic_tool" ? { title: read.title, input: read.input } : null,
        { title: "Read src/env.ts", input: { path: "src/env.ts" } },
      );
      const search = items.find((item) => item.type === "file_search");
      assert.deepEqual(
        search?.type === "file_search" ? { title: search.title, pattern: search.pattern } : null,
        { title: "Searched TODO in web", pattern: "apps/web" },
      );
      const webItem = (nativeId: string, status: string) => {
        const item = items.findLast(
          (candidate) =>
            candidate.type === "web_search" &&
            candidate.status === status &&
            candidate.nativeItemRef?.nativeId?.endsWith(nativeId) === true,
        );
        return item?.type === "web_search"
          ? { title: item.title, patterns: item.patterns, results: item.results }
          : null;
      };
      assert.deepEqual(webItem("grok-x-search", "running"), {
        title: "X search",
        patterns: undefined,
        results: undefined,
      });
      assert.deepEqual(webItem("grok-x-search", "completed"), {
        title: "X search: conversation_id:42",
        patterns: ["conversation_id:42"],
        results: undefined,
      });
      assert.deepEqual(webItem("grok-web-search", "completed"), {
        title: "Web search: t3 code",
        patterns: ["t3 code"],
        results: [{ url: "https://t3.codes" }, { url: "https://github.com/pingdotgg/t3code" }],
      });
      assert.deepEqual(webItem("grok-web-fetch", "completed")?.results, [
        { url: "https://t3.codes", snippet: "T3 Code page" },
      ]);
      const completedCompaction = items.find(
        (item) =>
          item.type === "compaction" &&
          item.status === "completed" &&
          item.summary === "Retained decisions.",
      );
      assert.isDefined(completedCompaction);
      assert.notProperty(completedCompaction!, "afterTokenCount");

      assert.isDefined(sessionUpdateHandler);
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message",
          messageId: "late-authoritative-message",
          content: [{ type: "text", text: "late authoritative text" }],
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message",
          messageId: "late-authoritative-message",
        },
      });
      const afterOmittedPatch = yield* runtime.readThreadSnapshot({ providerThread });
      assert.isTrue(
        afterOmittedPatch.messages.some((message) => message.text === "late authoritative text"),
        "omitted late message content must preserve the authoritative text",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("projects only the tail of long ACP terminal output", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test-long-terminal");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TERMINAL_OUTPUT_BYTES: String(1024 * 1024) },
          }),
        },
        selfInvocation: yield* resolveSelfInvocation(),
      });
      const threadId = ThreadId.make("thread-acp-long-terminal");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-long-terminal"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
      );
      const outputs = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
          ? [event.turnItem.output ?? ""]
          : [],
      );
      const fullOutput = Array.from(
        { length: (1024 * 1024) / 64 },
        (_, index) => `${String(index + 1).padStart(8, "0")} ${"x".repeat(54)}\n`,
      ).join("");

      assert.isAtLeast(outputs.length, 2);
      assert.isAtMost(Math.max(...outputs.map((output) => output.length)), 320 * 1024);
      assert.equal(outputs.at(-1), fullOutput.slice(-320 * 1024));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
