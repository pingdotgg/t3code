// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";
import type {
  ElicitationRequest,
  Query as ClaudeQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  type ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  type ResolvedProviderInstanceEnvironment,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Tool } from "effect/ai";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as PortScanner from "../../preview/PortScanner.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../testkit/DeterministicRuntime.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { layerProviderReplay } from "../testkit/ProviderReplayHarness.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "../testkit/fixtures/shared.ts";

import {
  CLAUDE_TEST_RESTART_MODEL_SELECTION,
  makeClaudeTestTurnInput,
  options,
  form,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  wakeTaskStarted,
  makeResultFrame,
  turnOneResult,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  testLayer,
  approvalOnly,
  startElicitationTurn,
} from "./ClaudeAdapterV2-fixtures.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

describe("ClaudeAdapterV2 background wake turns", () => {
  describe("MCP elicitations", () => {
    const testLayer = Layer.mergeAll(
      IdAllocator.layer,
      McpProviderSessions.layer,
      NodeServices.layer,
      NodeCrypto.layer,
    );
    const approvalOnly: ElicitationRequest = {
      serverName: "deploys",
      message: "Deploy web to production?",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
      title: "Deploy",
    };

    const startElicitationTurn = Effect.fnUntraced(function* (
      options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
    ) {
      const harness = yield* makeWakeHarnessWithOptions(options);
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-elicitation"),
          text: "Deploy web.",
          attachments: [],
        }),
      );
      const onElicitation = harness.getOpenedOptions()?.onElicitation;
      if (onElicitation === undefined) throw new Error("The Claude query has no onElicitation.");
      const runtimeRequests = () =>
        harness.events.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
      let requestNumber = 0;
      const elicit = (request: ElicitationRequest, signal = new AbortController().signal) =>
        Effect.promise(() =>
          onElicitation(request, { signal, requestId: `sdk-${requestNumber++}` }),
        ).pipe(Effect.forkScoped);
      const awaitCard = Effect.fnUntraced(function* (count: number) {
        const event = yield* Queue.take(harness.runtimeRequestReceipts);
        assert.equal(runtimeRequests().length, count);
        return event.runtimeRequest;
      });
      return { harness, elicit, awaitCard, runtimeRequests };
    });

    it.effect("shows an approval-only form and accepts only after Approve", () =>
      Effect.gen(function* () {
        const { harness, elicit, awaitCard } = yield* startElicitationTurn();
        const answer = yield* elicit(approvalOnly);
        const request = yield* awaitCard(1);
        assert.equal(request.kind, "mcp-elicitation");
        assert.isTrue(request.responseCapability.type === "live");
        if (request.responseCapability.type === "live") {
          assert.isUndefined(request.responseCapability.supportsFeedback);
        }
        const card = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.deepInclude(card?.type === "turn_item.updated" ? card.turnItem : undefined, {
          prompt: "Deploy web to production?",
          appName: "Deploy",
          options: [
            { decision: "cancel", label: "Cancel" },
            { decision: "decline", label: "Decline" },
            { decision: "accept", label: "Approve" },
          ],
        });
        assert.isUndefined(answer.pollUnsafe());

        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.id,
          decision: "accept",
        });
        assert.deepEqual(yield* Fiber.join(answer), { action: "accept", content: {} });

        // The card is gone, so a second click is an unknown request.
        const late = yield* Effect.flip(
          harness.runtime.respondToRuntimeRequest({ requestId: request.id, decision: "decline" }),
        );
        assert.include(String(late.cause), "No pending Claude runtime request");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect.each(["decline", "cancel"] as const)("answers %s with that action", (decision) =>
      Effect.gen(function* () {
        const { harness, elicit, awaitCard } = yield* startElicitationTurn();
        const answer = yield* elicit(approvalOnly);
        const request = yield* awaitCard(1);
        yield* harness.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
        assert.deepEqual(yield* Fiber.join(answer), { action: decision });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect.each(["acceptForSession", "acceptAlways"] as const)(
      "declines an unsupported %s decision",
      (decision) =>
        Effect.gen(function* () {
          const { harness, elicit, awaitCard } = yield* startElicitationTurn();
          const answer = yield* elicit(approvalOnly);
          const request = yield* awaitCard(1);
          yield* harness.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
          assert.deepEqual(yield* Fiber.join(answer), { action: "decline" });
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("declines URL and value forms without a card", () =>
      Effect.gen(function* () {
        const { elicit, runtimeRequests } = yield* startElicitationTurn();
        for (const request of [
          { ...approvalOnly, mode: "url", url: "https://example.com/auth" },
          {
            ...approvalOnly,
            requestedSchema: {
              type: "object",
              properties: { reason: { type: "string" } },
              required: ["reason"],
            },
          },
        ] satisfies ReadonlyArray<ElicitationRequest>) {
          assert.deepEqual(yield* Fiber.join(yield* elicit(request)), { action: "decline" });
        }
        assert.isEmpty(runtimeRequests());
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("cancels an already-aborted request without a card", () =>
      Effect.gen(function* () {
        const { harness, elicit, awaitCard, runtimeRequests } = yield* startElicitationTurn();
        const aborted = yield* Effect.sync(() => {
          const controller = new AbortController();
          controller.abort();
          return controller.signal;
        });
        const answer = yield* elicit(approvalOnly, aborted);
        assert.deepEqual(yield* Fiber.join(answer), { action: "cancel" });
        assert.isEmpty(runtimeRequests());
        const next = yield* elicit(approvalOnly);
        const card = yield* awaitCard(1);
        assert.equal(card.nativeRequestRef?.nativeId, "mcp-elicitation:sdk-1");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: card.id, decision: "accept" });
        assert.deepEqual(yield* Fiber.join(next), { action: "accept", content: {} });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("withdraws an open card when the SDK cancels while the session continues", () =>
      Effect.gen(function* () {
        const { harness, elicit, awaitCard } = yield* startElicitationTurn();
        const controller = yield* Effect.sync(() => new AbortController());
        const answer = yield* elicit(approvalOnly, controller.signal);
        const request = yield* awaitCard(1);
        yield* Effect.sync(() => controller.abort());
        assert.deepEqual(yield* Fiber.join(answer), { action: "cancel" });
        const cancelled = yield* Queue.take(harness.runtimeRequestReceipts);
        assert.equal(cancelled.runtimeRequest.id, request.id);
        assert.equal(cancelled.runtimeRequest.status, "cancelled");
        assert.equal(
          harness.events.findLast((e) => e.type === "node.updated")?.node.status,
          "cancelled",
        );
        assert.equal(
          harness.events.findLast((e) => e.type === "turn_item.updated")?.turnItem.status,
          "cancelled",
        );
        yield* Effect.flip(
          harness.runtime.respondToRuntimeRequest({ requestId: request.id, decision: "accept" }),
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("cancels an open card when the session stops", () =>
      Effect.gen(function* () {
        // Like the SDK, the fake query aborts in-flight callbacks when closed.
        const inFlight = yield* Effect.sync(() => new AbortController());
        const session = yield* Scope.make();
        const { elicit, awaitCard } = yield* startElicitationTurn({
          close: () => Effect.sync(() => inFlight.abort()),
        }).pipe(Scope.provide(session));
        const answer = yield* elicit(approvalOnly, inFlight.signal);
        yield* awaitCard(1);
        assert.isUndefined(answer.pollUnsafe());

        yield* Scope.close(session, Exit.void);
        assert.deepEqual(yield* Fiber.join(answer), { action: "cancel" });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });
  it.effect(
    "applies model, effort and Fast changes to a process running a background shell, but not thinking or a cleared effort",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const normal = {
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            model: "claude-opus-5-5",
          } satisfies ModelSelection;
          const turn = (ordinal: number, modelSelection: ModelSelection) =>
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(`attempt-normal-background:${ordinal}`),
              text: `Request ${ordinal}`,
              attachments: [],
              providerTurnOrdinal: ordinal,
              modelSelection,
            });
          const settle = Effect.gen(function* () {
            yield* harness.offerAndWait(turnOneResult);
            yield* Queue.take(harness.terminalReceipts);
          });
          yield* harness.runtime.startTurn(turn(1, normal));
          const originalOptions = harness.getOpenedOptions();
          yield* harness.offerAndWait(wakeTaskStarted);
          yield* settle;
          assert.isTrue(yield* harness.hasPendingBackgroundWork);

          yield* harness.runtime.startTurn(
            turn(2, { ...normal, options: [{ id: "fastMode", value: false }] }),
          );
          yield* settle;
          assert.deepEqual(harness.liveSelectionChanges, []);

          yield* harness.runtime.startTurn(
            turn(3, {
              ...normal,
              options: [
                { id: "effort", value: "ultracode" },
                { id: "fastMode", value: true },
              ],
            }),
          );
          yield* settle;
          yield* harness.runtime.startTurn(turn(4, { ...normal, model: "claude-sonnet-4-6" }));
          yield* settle;
          assert.deepEqual(harness.liveSelectionChanges, [
            { effortLevel: "xhigh", fastMode: true, ultracode: true },
            { model: "claude-sonnet-4-6" },
            { effortLevel: "high", fastMode: null, ultracode: null },
          ]);
          assert.strictEqual(harness.getOpenedOptions(), originalOptions);
          assert.lengthOf(harness.offeredMessages, 4);

          for (const [ordinal, selection] of [
            [5, CLAUDE_TEST_RESTART_MODEL_SELECTION],
            [6, { ...normal, model: "claude-haiku-4-5-20251001" }],
          ] as const) {
            const refused = yield* harness.runtime
              .startTurn(turn(ordinal, selection))
              .pipe(Effect.result);
            assert.equal(refused._tag, "Failure");
            if (refused._tag === "Failure") {
              assert.instanceOf(
                refused.failure.cause,
                ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError,
              );
            }
          }
          assert.strictEqual(harness.getOpenedOptions(), originalOptions);
          assert.lengthOf(harness.offeredMessages, 4);
          assert.lengthOf(harness.liveSelectionChanges, 3);
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
  it.effect("re-sends the model on the turn after a live selection change fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failFlags = true;
        const harness = yield* makeWakeHarnessWithOptions({
          applyFlagSettings: () =>
            Effect.suspend(() => {
              if (!failFlags) return Effect.void;
              failFlags = false;
              return Effect.fail(
                new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                  method: "applyFlagSettings",
                  cause: new Error("control request failed"),
                }),
              );
            }),
        });
        const now = yield* DateTime.now;
        const opus = {
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-opus-5-5",
        } satisfies ModelSelection;
        const turn = (ordinal: number, modelSelection: ModelSelection) =>
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-failed-live-change:${ordinal}`),
            text: `Request ${ordinal}`,
            attachments: [],
            providerTurnOrdinal: ordinal,
            modelSelection,
          });
        yield* harness.runtime.startTurn(turn(1, opus));
        yield* harness.offerAndWait(turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        const failed = yield* harness.runtime
          .startTurn(turn(2, { ...opus, model: "claude-sonnet-4-6" }))
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");

        // The process may now run Sonnet, so returning to Opus must send it.
        yield* harness.runtime.startTurn(turn(3, opus));
        assert.deepEqual(harness.liveSelectionChanges, [
          { model: "claude-sonnet-4-6" },
          { effortLevel: "high", fastMode: null, ultracode: null },
          { model: "claude-opus-5-5" },
          { effortLevel: "medium", fastMode: false, ultracode: null },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect.each(["completed", "interrupted"] as const)(
    "projects Claude thinking blocks when %s",
    (status) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("reasoning-attempt"),
            text: "Check the plan",
            attachments: [],
          }),
        );
        const stream = (event: unknown, parent: string | null = null) =>
          claudeSdkFrame({
            type: "stream_event",
            event,
            parent_tool_use_id: parent,
            session_id: WAKE_NATIVE_SESSION,
            uuid: "stream-frame",
          });
        const snapshot = (id: string, uuid: string, thinking: string) =>
          claudeSdkFrame({
            type: "assistant",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
            parent_tool_use_id: null,
            message: {
              id,
              model: "claude-sonnet-4-6",
              content: [{ type: "thinking", thinking, signature: "secret-signature" }],
            },
          });
        const frames = [
          stream({ type: "message_start", message: { id: "thought-message" } }),
          stream({
            type: "content_block_start",
            index: 2,
            content_block: { type: "thinking", thinking: "" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "First " },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "thought" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "signature_delta", signature: "secret-signature" },
          }),
          stream({ type: "content_block_stop", index: 2 }),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          stream({
            type: "content_block_start",
            index: 4,
            content_block: { type: "thinking", thinking: "Second thought" },
          }),
          stream({ type: "content_block_stop", index: 4 }),
          snapshot("thought-message", "second-snapshot", ""),
          snapshot("completion-only", "third-snapshot", "Completion only"),
          snapshot("redacted", "empty-snapshot", ""),
          stream({ type: "message_start", message: { id: "child-message" } }, "child-tool"),
          stream(
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "Child thought" },
            },
            "child-tool",
          ),
          stream({ type: "message_start", message: { id: "partial-message" } }),
          stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Partial thought" },
          }),
          makeResultFrame({
            uuid: "reasoning-result",
            result: "",
            ...(status === "interrupted" ? { terminalReason: "aborted_streaming" as const } : {}),
          }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, status);
        const latest = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        assert.deepEqual(
          [...latest.values()].map((item) => item.text),
          ["Authoritative first thought", "Second thought", "Completion only", "Partial thought"],
        );
        assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, 4);
        for (const item of latest.values()) {
          assert.equal(item.streaming, false);
          assert.isNotNull(item.completedAt);
        }
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          ),
        );
        for (const item of latest.values()) assert.notInclude(item.text, "secret-signature");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  // regression: #15892 non-execution metadata is carried through, not guessed from result text
  it.effect.each(["cancelled", "denied", "permission_denied", undefined])(
    "preserves native tool non-execution metadata %s without inferring a denial from text",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-tool-non-execution"),
              text: "Run the tool.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "user",
              uuid: "tool-non-execution",
              session_id: WAKE_NATIVE_SESSION,
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-error",
                    is_error: true,
                    content: "STOP and wait for the user.",
                  },
                  { type: "tool_result", tool_use_id: "tool-ok", is_error: false, content: "OK" },
                ],
              },
              ...(kind === undefined
                ? {}
                : {
                    tool_result_meta: [
                      { id: "tool-error", non_execution_kind: kind },
                      { id: "tool-ok", non_execution_kind: null },
                    ],
                  }),
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "result-non-execution", result: "Done" }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const items = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
              ? [event.turnItem]
              : [],
          );
          const failed = items.findLast((item) => item.nativeItemRef?.nativeId === "tool-error")!;
          assert.equal(failed.status, kind === "cancelled" ? "cancelled" : "failed");
          assert.equal(failed.toolNonExecutionKind, kind);
          const ok = items.findLast((item) => item.nativeItemRef?.nativeId === "tool-ok")!;
          assert.equal(ok.status, "completed");
          assert.equal(ok.toolNonExecutionKind, undefined);
          const node = harness.events.findLast(
            (event) =>
              event.type === "node.updated" && event.node.nativeItemRef?.nativeId === "tool-error",
          );
          assert.equal(node?.type === "node.updated" ? node.node.status : undefined, failed.status);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
  it.effect("completes a turn after the resume dialog without a failed tool row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-resume-dialog"),
            text: "continue",
            attachments: [],
          }),
        );
        const dialog = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.onUserDialog!(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
            },
            { signal: new AbortController().signal, requestId: "dialog-resume" },
          ),
        ).pipe(Effect.forkScoped);
        const request = yield* Queue.take(harness.runtimeRequestReceipts);
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "node.updated" && event.node.id === request.runtimeRequest.nodeId
              ? [event.node.parentNodeId]
              : [],
          ),
          [NodeId.make("node-attempt-resume-dialog")],
        );
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          answers: {
            [formatClaudeResumeCompactionQuestion({ ageMinutes: 90, estimatedTokens: 120000 })]:
              "Keep full history",
          },
        });
        assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "continue" });
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "result-resume-dialog", result: "Done" }),
        );
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === "dialog-resume"
              ? [event.turnItem.status]
              : [],
          ),
          [],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
});
