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
  DROID_SETTINGS,
  layerTest,
  ACP_TEST_DRIVER,
  makeMockRuntime,
  droidSchema,
  droidQuestions,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
  it.live("reports per-turn usage unavailable when the agent omits usage", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-per-turn-missing");
      const threadId = ThreadId.make("thread-acp-per-turn-missing");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-per-turn-missing"),
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
      const completed = events.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("keeps usage unavailable for undeclared agents even when they report usage", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-usage-undeclared");
      const threadId = ThreadId.make("thread-acp-usage-undeclared");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () =>
                Effect.succeed({
                  stopReason: "end_turn" as const,
                  usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-usage-undeclared"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      for (const ordinal of [1, 2]) {
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
        );
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const completed = events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        // Usage semantics are unverified for an undeclared agent, so its
        // counters are never trusted, on any turn.
        assert.deepEqual(
          completed?.type === "provider_turn.updated"
            ? completed.providerTurn.turnTokenUsage
            : null,
          { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live.each(["details", "none"] as const)(
    "fails the turn on an ACP v2 idle error with %s, settles its open tool, and accepts the next prompt",
    (details) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const instanceId = ProviderInstanceId.make(`idle-error-${details}`);
        const threadId = ThreadId.make(`thread-idle-error-${details}`);
        const childSessionId = "mock-child-session-idle-error";
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            extractBackgroundTaskId: (toolCall) =>
              toolCall.toolCallId === "tool-call-idle-error-monitor"
                ? "idle-error-monitor"
                : undefined,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId === "tool-call-idle-error-subagent"
                ? {
                    nativeTaskId: "task-idle-error",
                    prompt: "child work",
                    title: "child work",
                    model: null,
                    status: toolCall.status === "completed" ? "completed" : "running",
                    childSessionId,
                    result: null,
                    suppressNormalTool: true,
                  }
                : undefined,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              environment: { T3_ACP_IDLE_ERROR: details },
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-idle-error-${details}`),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const runTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* runtime.startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now: yield* DateTime.now,
                ordinal,
              }),
            );
            return yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            );
          });

        const failedEvents = yield* runTurn(1);
        const failed = failedEvents.at(-1);
        assert.equal(failed?.type, "turn.terminal");
        if (failed?.type !== "turn.terminal" || failed.status !== "failed") {
          return assert.fail("expected a failed terminal");
        }
        assert.isTrue(
          failed.childTurnsContinue,
          "the run keeps ingesting work that outlives the failed prompt",
        );
        const lateSubagent = yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
          ),
          Stream.runHead,
          Effect.timeoutOption("2 seconds"),
        );
        assert.isTrue(
          Option.isSome(lateSubagent) && Option.isSome(lateSubagent.value),
          "a subagent finishing after the failed prompt still reports to the run",
        );
        assert.deepEqual(
          failed.failure,
          details === "details"
            ? {
                class: "provider_error",
                message: "Missing Authentication header",
                code: "-32000",
                retryable: null,
              }
            : {
                class: "provider_error",
                message: "Provider turn failed.",
                code: null,
                retryable: null,
              },
        );
        const toolItems = (nativeId: string) =>
          failedEvents.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId
              ? [event.turnItem]
              : [],
          );
        const toolStatuses = toolItems("tool-call-idle-error-1").map((item) => item.status);
        assert.include(toolStatuses, "running");
        assert.equal(toolStatuses.at(-1), "failed");
        assert.deepEqual(
          toolItems("tool-call-idle-error-monitor").map((item) => item.status),
          ["running"],
          "a background monitor outlives the failed turn and keeps its running row",
        );
        const childItems = toolItems("task-idle-error:tool:tool-call-idle-error-child");
        assert.deepEqual(
          childItems.map((item) => item.status),
          ["running"],
          "a child-session tool keeps running in its own thread",
        );
        assert.isTrue(childItems.every((item) => item.threadId !== threadId));
        assert.isEmpty(
          toolItems("tool-call-idle-error-child"),
          "the failed turn must not reproject the child tool as a root tool",
        );

        const nextEvents = yield* runTurn(2);
        const next = nextEvents.at(-1);
        assert.equal(next?.type === "turn.terminal" ? next.status : undefined, "completed");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Factory Droid 0.243.0 sends an optional text companion for every AskUser choice.
  it.live.each([
    {
      scenario: "preserves selected IDs and encodes custom answers",
      schema: droidSchema,
      questions: droidQuestions,
      answers: { question_1: "option_1", question_2: "Markdown" },
      result: {
        action: "accept",
        content: { question_1: "option_1", question_2: "other", question_2_other: "Markdown" },
      },
    },
    {
      scenario: "preserves selected labels and attachment paths in custom answers",
      schema: droidSchema,
      questions: droidQuestions,
      withAttachments: true,
      answers: {
        question_1: "option_1",
        question_2: "option_1\n\nAttached notes: keep this custom text",
      },
      result: (directory: string) => ({
        action: "accept",
        content: {
          question_1: "other",
          question_1_other: `Plain text\n\nAttached image "shot.png": ${JSON.stringify(NodePath.join(directory, "droid-shot.png"))}\nAttached file "spec.txt": ${JSON.stringify(NodePath.join(directory, "droid-spec.txt"))}`,
          question_2: "other",
          question_2_other: "option_1\n\nAttached notes: keep this custom text",
        },
      }),
    },
    {
      scenario: "cancels without accepting answers",
      schema: droidSchema,
      questions: droidQuestions,
      answers: undefined,
      result: { action: "cancel" },
    },
    {
      scenario: "falls back for an unrelated form",
      schema: { type: "object", properties: { name: { type: "string" } } },
      questions: [{ id: "name", header: "Question 1", question: "Your answer?", options: [] }],
      answers: { name: "Ada" },
      result: { action: "accept", content: { name: "Ada" } },
    },
  ])("Droid elicitation $scenario", ({ schema, questions, answers, result, withAttachments }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-droid-form-" });
      const statusPath = path.join(directory, "status.json");
      const expectedResult = typeof result === "function" ? result(directory) : result;
      let preparedAnswers: ProviderUserInputAnswers | undefined = answers;
      if (withAttachments && answers !== undefined) {
        yield* fileSystem.writeFileString(path.join(directory, "droid-shot.png"), "image");
        yield* fileSystem.writeFileString(path.join(directory, "droid-spec.txt"), "spec");
        preparedAnswers = yield* appendUserInputAttachmentPaths({
          answers,
          attachmentsDir: directory,
          attachmentsByQuestionId: {
            question_1: [
              {
                type: "image",
                id: "droid-shot",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
              {
                type: "file",
                id: "droid-spec",
                name: "spec.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
          },
        });
      }
      const driver = ProviderDriverKind.make("acpRegistry");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: driver,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "droid-form",
          entries: [
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "initialize", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "initialize",
                result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/new", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/new",
                result: { sessionId: "droid-session" },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "request",
                method: "elicitation/create",
                params: {
                  mode: "form",
                  sessionId: "droid-session",
                  message: "Your answer?",
                  requestedSchema: schema,
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                kind: "response",
                method: "elicitation/create",
                result: expectedResult,
              },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "end_turn" },
              },
            },
            { type: "runtime_exit", status: "success" },
          ],
        },
        driver,
      );
      const instanceId = ProviderInstanceId.make("droid-form-test");
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        settings: DROID_SETTINGS,
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          fileSystem,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        }),
      }).pipe(
        Effect.provide(
          Layer.mock(AcpRegistryCatalog)({ resolve: () => Effect.die("runtime is injected") }),
        ),
      );
      const threadId = ThreadId.make("droid-form-thread");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: directory,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        modelSelection,
        runtimePolicy,
        providerSessionId: ProviderSessionId.make("droid-form-session"),
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
      const item = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
          ),
          Stream.runHead,
        ),
      );
      if (item.type !== "turn_item.updated" || item.turnItem.type !== "user_input_request")
        return yield* Effect.die("Expected Droid question");
      assert.deepEqual(item.turnItem.questions, questions);
      yield* runtime.respondToRuntimeRequest({
        requestId: item.turnItem.requestId,
        ...(preparedAnswers === undefined ? {} : { answers: preparedAnswers }),
      });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(Option.getOrThrow(terminal).status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live.each(["failed", "recovered", "cancelled"] as const)(
    "projects Mistral retry notices and their %s outcome",
    (outcome) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const instanceId = ProviderInstanceId.make(`vibe-retry-${outcome}`);
        const threadId = ThreadId.make(`thread-vibe-retry-${outcome}`);
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make("acpRegistry"),
            capabilities: AcpProviderCapabilitiesV2,
            registerExtensions: registerMistralVibeAcpExtensions,
            promptFailure: (cause) => acpRegistryPromptFailure("mistral-vibe", cause),
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              environment: { T3_ACP_VIBE_RETRY_OUTCOME: outcome },
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-vibe-retry-${outcome}`),
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
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const retries = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? [event.turnItem]
            : [],
        );
        const running = retries.filter((item) => item.status === "running");
        assert.deepEqual(
          running.map((item) => item.retry?.attempt),
          [1, 2],
        );
        assert.equal(new Set(retries.map((item) => item.id)).size, 1);
        assert.include(running[0]!.failure.message, "Rate limit reached");
        assert.notInclude(running[0]!.failure.message, "private-key");
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.isDefined(terminal);
        if (terminal?.type !== "turn.terminal") return yield* Effect.die("Missing terminal");
        if (outcome === "failed") {
          assert.equal(terminal.status, "failed");
          assert.equal(terminal.failure?.class, "usage_limit");
          assert.include(terminal.failure?.message ?? "", "Rate limit exceeded for mistral");
          if (terminal.status === "failed") assert.equal(terminal.retry?.attempt, 2);
        } else if (outcome === "cancelled") {
          assert.equal(terminal.status, "cancelled");
          assert.equal(retries.at(-1)?.status, "cancelled");
          assert.equal(retries.at(-1)?.title, "Provider retry stopped");
        } else {
          assert.equal(terminal.status, "completed");
          assert.equal(retries.at(-1)?.status, "completed");
          assert.equal(retries.at(-1)?.title, "Provider recovered");
        }
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
