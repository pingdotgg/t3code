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

import { layerTest, ACP_TEST_DRIVER, makeMockRuntime, sessionId } from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.effect("persists a bounded subset of streamed root and child tool updates", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      // Devin resends the growing file without status on each update.
      const file = `${"x = 1\n".repeat(800)}END_OF_FILE\n`;
      const chunks = 200;
      const streamedWrite = (
        toolCallId: string,
        parentAgentId?: string,
      ): Array<EffectAcpSchema.SessionUpdate> => {
        const meta =
          parentAgentId === undefined ? {} : { "cognition.ai/subagent_context": { parentAgentId } };
        const write = (text: string, status?: "completed") => ({
          sessionUpdate: "tool_call_update" as const,
          toolCallId,
          title: "Writing ./audit.py",
          ...(status === undefined ? {} : { status }),
          content: [
            { type: "diff" as const, path: "/repo/audit.py", oldText: null, newText: text },
          ],
          rawInput: { file_path: "/repo/audit.py", content: text },
          _meta: meta,
        });
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Writing …",
            kind: "edit",
            status: "pending",
            _meta: meta,
          },
          ...Array.from({ length: chunks }, (_, index) =>
            write(file.slice(0, Math.ceil((file.length * (index + 1)) / chunks))),
          ),
          write(file, "completed"),
        ];
      };
      const instanceId = ProviderInstanceId.make("devin-streamed-write");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          normalizeSessionUpdate: normalizeDevinSessionUpdate,
          normalizeToolCall: normalizeDevinToolCall,
          extractSubagentUpdate: extractDevinSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              prompt: () =>
                Effect.gen(function* () {
                  const updates = [
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Write audit script",
                          task: "Write audit.py.",
                        },
                      },
                    },
                    ...streamedWrite("root-write"),
                    ...streamedWrite("child-write", "child-a"),
                    ...Array.from({ length: 5 }, (_, index) => ({
                      sessionUpdate: "tool_call_update" as const,
                      toolCallId: "ticker",
                      title: "Watch ticks",
                      kind: "execute" as const,
                      status: "in_progress" as const,
                      rawOutput: `tick ${index + 1}`,
                    })),
                    ...Array.from({ length: 5 }, (_, index) => ({
                      sessionUpdate: "tool_call_update" as const,
                      toolCallId: "text-ticker",
                      title: "Watch ticks",
                      kind: "execute" as const,
                      status: "in_progress" as const,
                      rawOutput: { type: "Text", text: `tock ${index + 1}` },
                    })),
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "completed",
                      _meta: {
                        "cognition.ai/subagent_completed": {
                          agentId: "child-a",
                          success: true,
                          summary: "Wrote audit.py",
                        },
                      },
                    },
                  ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                  for (const update of updates)
                    yield* handler!({ sessionId: "mock-session-1", update });
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("devin-streamed-write");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("devin-streamed-write-session"),
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
      const items = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
      for (const toolCallId of ["root-write", "child-write"]) {
        const writes = items.filter((item) => item.nativeItemRef?.nativeId?.endsWith(toolCallId));
        assert.isAtLeast(writes.length, chunks / 10, toolCallId);
        assert.isAtMost(writes.length, chunks / 5, toolCallId);
        assert.equal(writes.at(-1)?.status, "completed", toolCallId);
        assert.include(JSON.stringify(writes.at(-1)), "END_OF_FILE", toolCallId);
      }
      for (const [toolCallId, word] of [
        ["ticker", "tick"],
        ["text-ticker", "tock"],
      ] as const) {
        const ticks = items.filter((item) => item.nativeItemRef?.nativeId?.endsWith(toolCallId));
        for (let tick = 1; tick <= 5; tick++) {
          assert.isTrue(
            ticks.some((item) => JSON.stringify(item).includes(`${word} ${tick}`)),
            `${word} ${tick} must persist`,
          );
        }
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("keeps Devin parent paragraphs intact while projecting native child work", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      let createTerminal: Parameters<Runtime["handleCreateTerminal"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("devin-replay");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        clientTerminals: { shellCommands: true },
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          normalizeSessionUpdate: normalizeDevinSessionUpdate,
          normalizeToolCall: normalizeDevinToolCall,
          extractSubagentUpdate: extractDevinSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              handleCreateTerminal: (next) =>
                Effect.sync(() => {
                  createTerminal = next;
                }).pipe(Effect.andThen(runtime.handleCreateTerminal(next))),
              prompt: () =>
                Effect.gen(function* () {
                  assert.isDefined(handler);
                  assert.isDefined(createTerminal);
                  const fallbackTerminal = yield* createTerminal(
                    { sessionId: "mock-session-1", command: "true acp-mcp-call task_status {}" },
                    { requestId: "child-mcp-terminal", method: "terminal/create" },
                  );
                  const updates = [
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Map orchestration",
                          task: "Run pwd, then reply ONE.",
                          model: " \t ",
                        },
                      },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Map orchestration",
                          task: "Run pwd, then reply ONE.",
                          model: "SWE-1.7 Medium",
                          depth: 1,
                          isBackground: true,
                        },
                      },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Map orchestration (command" },
                      _meta: { "cognition.ai/streamingMessageId": "parent-message" },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "parent-tool",
                      status: "completed",
                      title: "Parent tool finished",
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-pwd",
                      title: "Tool",
                      kind: "execute",
                      status: "in_progress",
                      rawInput: { command: "pwd" },
                      _meta: {
                        "cognition.ai/inferenceToolName": "exec",
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-weather",
                      title: "Check weather",
                      status: "completed",
                      rawInput: { server: "weather", tool: "get_weather", city: "Berlin" },
                      rawOutput: {
                        result: {
                          _meta: {
                            source: { name: "Weather", logoUrl: "https://example.com/weather.png" },
                          },
                          content: [{ type: "text", text: "Sunny" }],
                        },
                      },
                      _meta: {
                        is_mcp_tool_call: true,
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-mcp-fallback",
                      title: "Ran command",
                      kind: "execute",
                      status: "completed",
                      content: [{ type: "terminal", terminalId: fallbackTerminal.terminalId }],
                      _meta: { "cognition.ai/subagent_context": { parentAgentId: "child-a" } },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "parent-weather",
                      title: "Check weather",
                      status: "completed",
                      rawInput: { server: "weather", tool: "get_weather", city: "Berlin" },
                      rawOutput: {
                        _meta: {
                          source: { name: "Weather", logoUrl: "https://example.com/weather.png" },
                        },
                        content: [{ type: "text", text: "Sunny" }],
                      },
                      _meta: { is_mcp_tool_call: true },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: " → decider → event)." },
                      _meta: { "cognition.ai/streamingMessageId": "parent-message" },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-pwd",
                      status: "completed",
                      rawOutput: "probe-workspace",
                      _meta: { "cognition.ai/subagent_context": { parentAgentId: "child-a" } },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Checking the code." },
                      _meta: {
                        "cognition.ai/streamingMessageId": "child-progress",
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "ONE" },
                      _meta: {
                        "cognition.ai/streamingMessageId": "child-result",
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-later",
                      title: "Later tool",
                      status: "completed",
                      _meta: { "cognition.ai/subagent_context": { parentAgentId: "child-a" } },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "completed",
                      _meta: {
                        "cognition.ai/subagent_completed": {
                          agentId: "child-a",
                          success: true,
                          summary: "Final report: ONE",
                          depth: 1,
                        },
                      },
                    },
                  ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                  for (const update of updates)
                    yield* handler!({ sessionId: "mock-session-1", update });
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("devin-replay-parent");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("devin-replay-session"),
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
      const parentMessages = items.filter(
        (item) => item.threadId === threadId && item.type === "assistant_message",
      );
      assert.equal(new Set(parentMessages.map((item) => item.id)).size, 1);
      const lastParent = parentMessages.at(-1);
      assert.equal(
        lastParent?.type === "assistant_message" ? lastParent.text : undefined,
        "Map orchestration (command → decider → event).",
      );
      const tasks = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      const task = tasks.at(-1);
      assert.isNull(tasks[0]?.model);
      const childThread = events.find(
        (event) =>
          event.type === "app_thread.created" && event.appThread.id === task?.childThreadId,
      );
      assert.equal(
        childThread?.type === "app_thread.created"
          ? childThread.appThread.modelSelection.model
          : undefined,
        modelSelection.model,
      );
      assert.equal(task?.model, "SWE-1.7 Medium");
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "Final report: ONE");
      const childMessages = new Map(
        items.flatMap((item) =>
          item.threadId === task?.childThreadId && item.type === "assistant_message"
            ? [[item.id, item.text] as const]
            : [],
        ),
      );
      assert.deepEqual([...childMessages.values()], ["Checking the code.", "ONE"]);
      assert.equal(task?.prompt, "Run pwd, then reply ONE.");
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === task?.childThreadId &&
            item.type === "dynamic_tool" &&
            item.toolName === "t3-code.task_status",
        ),
      );
      const childMcp = items.find(
        (item) =>
          item.threadId === task?.childThreadId &&
          item.type === "dynamic_tool" &&
          item.toolName === "weather.get_weather",
      );
      const parentMcp = items.find(
        (item) =>
          item.threadId === threadId &&
          item.type === "dynamic_tool" &&
          item.toolName === "weather.get_weather",
      );
      for (const item of [parentMcp, childMcp]) {
        assert.equal(item?.title, "get weather");
        assert.deepEqual(item?.toolSource, {
          key: "mcp:weather",
          name: "Weather",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: "https://example.com/weather.png" },
        });
        assert.deepEqual(item?.toolIcon, item?.toolSource?.icon);
      }
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === task?.childThreadId &&
            item.type === "user_message" &&
            item.text === task.prompt,
        ),
      );
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === task?.childThreadId &&
            item.type === "dynamic_tool" &&
            item.status === "completed" &&
            item.output === "probe-workspace",
        ),
      );
      const childAnswers = items.filter(
        (item) => item.threadId === task?.childThreadId && item.type === "assistant_message",
      );
      assert.equal(new Set(childAnswers.map((item) => item.ordinal)).size, 2);
      const parentTools = items.filter(
        (item) => item.threadId === threadId && item.type === "dynamic_tool",
      );
      assert.equal(parentTools.length, 2);
      assert.equal(parentTools[0]?.title, "Parent tool finished");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
