import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

import {
  providerThreadId,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  withReplayRequestId,
  makeCodexReplayHarness,
  assistantMessages,
  nativeThreadId,
  request,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect.each(["before", "after"] as const)(
    "rejects a previous run's native turn when it completes %s the new start response",
    (completionOrder) =>
      Effect.gen(function* () {
        const nativeThreadId = "reused-turn-thread";
        const nativeTurnId = "reused-turn";
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const retry = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "retry-turn",
          prompt: "work",
        });
        const completion: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "original turn completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        };
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: `reused-turn-${completionOrder}`,
            entries: [
              ...preamble,
              withReplayRequestId(preamble[5]!, 4),
              ...(completionOrder === "before" ? [completion] : []),
              withReplayRequestId(preamble[6]!, 4),
              ...(completionOrder === "after" ? [completion] : []),
              ...retry.slice(5, 7).map((entry) => withReplayRequestId(entry, 5)),
              {
                type: "emit_inbound",
                label: "retry completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: "retry-turn", status: "completed" }),
                  },
                },
              },
            ],
          }),
        );
        const first = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("original"),
          text: "work",
        });
        yield* harness.runtime.startTurn(first);
        const result = yield* harness.runtime
          .startTurn({
            ...first,
            runId: RunId.make("replacement"),
            attemptId: RunAttemptId.make("replacement"),
            rootNodeId: NodeId.make("replacement"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure", "a different run must not adopt the original turn");
        if (result._tag !== "Failure") return;
        const failure = result.failure;
        assert.equal(failure._tag, "ProviderAdapterTurnStartError");
        assert.instanceOf(failure.cause, ProviderAdapter.ProviderAdapterProtocolError);
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.runOrdinal),
          [1],
        );
        yield* harness.runtime.startTurn({
          ...first,
          runId: RunId.make("retry"),
          attemptId: RunAttemptId.make("retry"),
          rootNodeId: NodeId.make("retry"),
          runOrdinal: 3,
          providerTurnOrdinal: 3,
        });
        yield* harness.awaitTerminal(2);
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.runOrdinal, event.status]),
          [
            [1, "completed"],
            [3, "completed"],
          ],
        );
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
  it.effect.each(["supported", "unsupported", "invalid"] as const)(
    "delivers native history with %s app-server protocol",
    (response) =>
      Effect.gen(function* () {
        const nativeThreadId = `inject-${response}`;
        const prompt = "Only the current request";
        const history: ProviderAdapter.ProviderAdapterV2HistoricalContext = {
          context: "Historical conversation",
          messages: (["user", "assistant"] as const).map((role) => ({
            role,
            text:
              role === "user"
                ? "Original request\n" + "界".repeat(300)
                : "Partial interrupted work",
            threadId: ThreadId.make("source"),
            runId: RunId.make("source-run"),
            itemId: TurnItemId.make(`source-${role}`),
            providerThreadId: null,
            kind: `${role}_message`,
            status: "interrupted",
          })),
        };
        const items = historyResponseItems(history.messages, history.context);
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "current-turn",
          prompt,
        });
        const transcript = makeCodexReplayTranscript({
          scenario: `inject-${response}`,
          entries: [
            ...preamble.slice(0, -3),
            {
              type: "expect_outbound",
              label: "inject",
              frame: {
                id: 3,
                method: "thread/inject_items",
                params: { threadId: nativeThreadId, items },
              },
            },
            {
              type: "emit_inbound",
              label: "inject-result",
              frame:
                response === "supported"
                  ? { id: 3, result: {} }
                  : {
                      id: 3,
                      error: {
                        code: response === "unsupported" ? -32601 : -32602,
                        message: "Injection rejected",
                      },
                    },
            },
            ...(response === "invalid"
              ? []
              : preamble
                  .slice(-3)
                  .map((entry) =>
                    "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry, frame: { ...entry.frame, id: 4 } }
                      : entry,
                  )),
          ],
        });
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const injection = yield* harness.runtime.injectHistory!({
          providerThread: harness.providerThread,
          ...history,
        }).pipe(Effect.result);
        if (response === "invalid") {
          assert.equal(injection._tag, "Failure");
          if (injection._tag === "Failure") {
            assert.equal(injection.failure._tag, "ProviderAdapterProtocolError");
            assert.propertyVal(injection.failure.cause, "code", -32602);
            assert.notProperty(injection.failure, "payload");
          }
          assert.notInclude(requests, "turn/start");
          return;
        }
        assert.equal(injection._tag, "Success");
        if (injection._tag === "Success") assert.equal(injection.success, response === "supported");
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("inject-attempt"),
            text: prompt,
          }),
        );
        assert.equal(requests.filter((method) => method === "turn/start").length, 1);
        assert.isBelow(requests.indexOf("thread/inject_items"), requests.indexOf("turn/start"));
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
  it.effect("adds the session MCP server without replacing launch-argument servers", () =>
    Effect.gen(function* () {
      const scenario = "launch-mcp-servers";
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-codex-mcp"),
        threadId: ThreadId.make(`thread-${scenario}`),
        providerSessionId: `provider-session-${scenario}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-codex-token",
        browserToolsAvailable: true,
      });
      const requests: Array<unknown> = [];
      yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario,
          entries: codexReplayPreamble({
            nativeThreadId: "launch-mcp-thread",
            nativeTurnId: "unused",
            prompt: "unused",
          }).slice(0, 5),
        }),
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/start") requests.push(params);
          }),
      );
      assert.deepEqual(requests, [
        {
          cwd: "/workspace",
          model: "gpt-5.4",
          config: {
            "tools.update_plan.enabled": true,
            mcp_optional_startup_grace_ms: 10_000,
            "shell_environment_policy.set.T3CODE_THREAD_ID": `thread-${scenario}`,
            "mcp_servers.t3-code": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer secret-codex-token" },
              disabled_tools: ["t3_thread_wait"],
            },
            "mcp_servers.t3-code-direct": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer secret-codex-token" },
              enabled_tools: ["t3_thread_wait"],
              omit_tools_from: ["code_mode", "deferred"],
            },
          },
        },
      ]);
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

  // regression: #15839 launch-arg MCP servers survive the thread's t3-code server
  it.effect("replays historical and dotted MCP config while enforcing other thread config", () =>
    Effect.gen(function* () {
      const recordedServer = {
        url: "http://127.0.0.1:41000/mcp",
        http_headers: { Authorization: "Bearer recorded-token" },
      };
      const currentConfig = {
        "tools.update_plan.enabled": true,
        "mcp_servers.t3-code": {
          url: "http://127.0.0.1:42000/mcp",
          http_headers: { Authorization: "Bearer current-token" },
        },
        "mcp_servers.extra.command": "cat",
      };
      for (const recordedMcp of [
        { mcp_servers: { "t3-code": recordedServer } },
        { "mcp_servers.t3-code": recordedServer, "mcp_servers.extra.command": "echo" },
      ]) {
        const entries = codexReplayPreamble({
          nativeThreadId: "replayed-mcp-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        })
          .slice(3, 5)
          .map((entry) => withReplayRequestId(entry, 1));
        entries[0] = {
          type: "expect_outbound",
          frame: {
            id: 1,
            method: "thread/start",
            params: { config: { "tools.update_plan.enabled": true, ...recordedMcp } },
          },
        };
        entries.push({
          ...entries[0],
          frame: {
            id: 2,
            method: "thread/start",
            params: { config: { "tools.update_plan.enabled": true, ...recordedMcp } },
          },
        });
        const driver = yield* CodexReplay.makeReplayDriver(
          makeCodexReplayTranscript({
            scenario: "mcp-config-normalization",
            entries,
          }),
        );
        yield* Effect.gen(function* () {
          const client = yield* CodexClient.CodexAppServerClient;
          const response = yield* client.request("thread/start", { config: currentConfig });
          assert.equal(response.thread.id, "replayed-mcp-thread");
          assert.isNull((yield* Ref.get(driver.state)).failure);
          yield* client
            .request("thread/start", {
              config: { ...currentConfig, "tools.update_plan.enabled": false },
            })
            .pipe(Effect.flip);
          assert.instanceOf(
            (yield* Ref.get(driver.state)).failure,
            CodexReplay.CodexAppServerReplayFrameMismatchError,
          );
        }).pipe(Effect.provide(CodexReplay.layerReplayWithDriver(driver)));
      }
    }).pipe(Effect.scoped),
  );
  it.effect("waits for native start before interrupting an acknowledged queued turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-await-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/started",
            afterMs: 1000,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
              },
            },
          },
          {
            type: "expect_outbound",
            label: "turn/interrupt",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: nativeTurnId },
            },
          },
          { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
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
  it.effect("keeps an asynchronous Codex question actionable after the turn completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "async-question-thread";
        const nativeTurnId = "async-question-turn";
        const usage = {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "async-question-and-billed-usage",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Continue while I decide.",
            }),
            {
              type: "emit_inbound",
              label: "question",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "agentMessage",
                    id: "async-question-item",
                    text: "Which branch?",
                    delivery: "async",
                    questions: [{ title: "Which branch?", options: ["main", "dev"] }],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "usage",
              frame: {
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("async-question-attempt"),
            text: "Continue while I decide.",
          }),
        );
        yield* harness.firstTerminal;
        const requests = harness.events.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
        assert.lengthOf(requests, 1);
        assert.equal(requests[0]?.status, "pending");
        assert.deepEqual(requests[0]?.responseCapability, { type: "message" });
        const questionItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        assert.equal(questionItem?.type, "turn_item.updated");
        if (
          questionItem?.type === "turn_item.updated" &&
          questionItem.turnItem.type === "user_input_request"
        ) {
          assert.deepEqual(
            questionItem.turnItem.questions[0]?.options.map((option) => option.label),
            ["main", "dev"],
          );
          assert.equal(questionItem.turnItem.responseMode, "message");
        }
        const questionNode = harness.events.find(
          (event) => event.type === "node.updated" && event.node.id === requests[0]?.nodeId,
        );
        assert.equal(
          questionNode?.type === "node.updated" && questionNode.node.countsForRun,
          false,
        );
        const contextReport = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined,
        );
        assert.equal(contextReport?.type, "provider_turn.updated");
        if (contextReport?.type === "provider_turn.updated") {
          assert.equal(
            contextReport.providerTurn.runAttemptId,
            RunAttemptId.make("async-question-attempt"),
          );
          assert.equal(contextReport.providerTurn.providerThreadId, harness.providerThread.id);
          assert.equal(contextReport.providerTurn.tokenUsage?.usedTokens, 15);
          assert.equal(contextReport.providerTurn.tokenUsage?.maxTokens, 200_000);
        }
        const completed = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningTokens: 1,
          });
        }
        assert.isEmpty(assistantMessages(harness.events));
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
