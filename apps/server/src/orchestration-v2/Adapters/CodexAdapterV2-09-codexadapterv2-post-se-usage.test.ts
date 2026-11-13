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
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  FAILED_PROMPT,
  failedMidCommandTranscript,
  MCP_APP_PROMPT,
  MCP_APP_RESOURCE,
  mcpAppTranscript,
  MCP_APP_DEFERRED_RESULT,
  mcpAppDeferredTranscript,
  nativeThreadId,
  notification,
  request,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect.each([
    {
      name: "usage",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "replacement",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "provider_error",
    },
    {
      name: "late-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "matching-details",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "deferred-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "retry", code: "usageLimitExceeded", notification: true, expectedClass: "usage_limit" },
    {
      name: "exhausted-429",
      code: "responseTooManyFailedAttempts",
      errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "exhausted-500",
      code: "responseTooManyFailedAttempts",
      errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
      notification: false,
      expectedClass: "provider_error",
    },
    {
      name: "chatgpt-workspace-limit",
      code: "other",
      details: "subscription_sharing_workplace_individual_usage_limit_exceeded",
      notification: true,
      expectedClass: "provider_error",
    },
  ] as const)("classifies Codex terminal failures from $name evidence", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = `native-limit-${scenario.name}`;
        const nativeTurnId = `turn-limit-${scenario.name}`;
        const message = "Provider stopped this request.";
        const errorInfo = "errorInfo" in scenario ? scenario.errorInfo : scenario.code;
        const resetAt = "2033-05-19T07:20:00.000Z";
        const snapshot = {
          type: "emit_inbound" as const,
          label: "account/rateLimits/updated",
          frame: {
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
              },
            },
          },
        };
        const transcript = makeCodexReplayTranscript({
          scenario: `codex-limit-${scenario.name}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
            ...(scenario.name === "deferred-reset" ? [snapshot] : []),
            ...(scenario.name === "deferred-reset"
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "item/completed/subAgentActivity-started",
                    frame: {
                      method: "item/completed",
                      params: {
                        threadId: nativeThreadId,
                        turnId: nativeTurnId,
                        item: {
                          type: "subAgentActivity",
                          id: "limit-child-spawn",
                          kind: "started",
                          agentThreadId: "native-limit-child",
                          agentPath: "/root/limit_child",
                        },
                      },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/started/child",
                    frame: {
                      method: "turn/started",
                      params: {
                        threadId: "native-limit-child",
                        turn: makeCodexReplayTurn({
                          id: "limit-child-turn",
                          status: "inProgress",
                        }),
                      },
                    },
                  },
                ]
              : []),
            ...(scenario.notification
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "error",
                    frame: {
                      method: "error",
                      params: {
                        threadId: nativeThreadId,
                        turnId: nativeTurnId,
                        willRetry: scenario.name === "retry",
                        error: {
                          message,
                          codexErrorInfo: errorInfo,
                          additionalDetails:
                            "details" in scenario
                              ? scenario.details
                              : scenario.name === "matching-details"
                                ? "Detailed provider allowance explanation."
                                : null,
                        },
                      },
                    },
                  },
                ]
              : []),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                    error: {
                      message: scenario.name === "replacement" ? "A different failure." : message,
                      ...(scenario.notification &&
                      scenario.name !== "matching-details" &&
                      !("details" in scenario)
                        ? {}
                        : { codexErrorInfo: errorInfo }),
                    },
                  },
                },
              },
            },
            ...(scenario.name === "late-reset" ? [snapshot] : []),
            ...(scenario.name === "deferred-reset"
              ? [
                  {
                    ...snapshot,
                    frame: {
                      method: "account/rateLimits/updated",
                      params: {
                        rateLimits: {
                          limitId: "codex",
                          primary: {
                            usedPercent: 100,
                            resetsAt: 2000200000,
                            windowDurationMins: 300,
                          },
                        },
                      },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/completed/child",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: "native-limit-child",
                        turn: makeCodexReplayTurn({
                          id: "limit-child-turn",
                          status: "completed",
                        }),
                      },
                    },
                  },
                ]
              : []),
          ],
        });
        const resetReceipt = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.failure.resetAt === resetAt
            ? Deferred.succeed(resetReceipt, undefined)
            : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            text: "Continue.",
            attemptId: RunAttemptId.make(`attempt-limit-${scenario.name}`),
          }),
        );
        yield* harness.firstTerminal;
        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.failure.class, scenario.expectedClass);
        assert.equal(terminal.threadDisposition, "reusable");
        if (scenario.name === "deferred-reset") assert.equal(terminal.failure.resetAt, resetAt);
        if (scenario.name === "matching-details")
          assert.equal(terminal.failure.message, "Detailed provider allowance explanation.");
        if (scenario.name === "late-reset") {
          yield* Deferred.await(resetReceipt);
          const item = harness.events.find(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.failure.resetAt === resetAt,
          );
          assert.isDefined(item);
        }
        if (scenario.name === "retry") assert.equal(terminal.retry?.attempt, 1);
        if (scenario.name === "chatgpt-workspace-limit") {
          assert.equal(terminal.failure.code, scenario.details);
          assert.include(terminal.failure.message, "workspace admin");
        }
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

  // regression: #17501 Codex 429 retry exhaustion classifies as a usage limit
  it.effect.each([
    {
      notificationStatus: 500,
      completionStatus: 429,
      willRetry: false,
      expectedClass: "usage_limit",
    },
    {
      notificationStatus: 429,
      completionStatus: 500,
      willRetry: true,
      expectedClass: "provider_error",
    },
    {
      notificationStatus: 429,
      completionStatus: null,
      willRetry: false,
      expectedClass: "usage_limit",
    },
    {
      notificationStatus: 429,
      completionStatus: null,
      willRetry: true,
      expectedClass: "usage_limit",
    },
  ] as const)(
    "honors completion HTTP status from $notificationStatus to $completionStatus (retry: $willRetry)",
    ({ notificationStatus, completionStatus, expectedClass, willRetry }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = `${notificationStatus}-${completionStatus}-${willRetry}`;
          const nativeThreadId = `native-exhaustion-status-${name}`;
          const nativeTurnId = `turn-exhaustion-status-${name}`;
          const message = "Provider stopped this request.";
          const additionalDetails = "Detailed notification evidence.";
          const transcript = makeCodexReplayTranscript({
            scenario: `codex-exhaustion-status-${name}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
              {
                type: "emit_inbound",
                label: "error",
                frame: {
                  method: "error",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    willRetry,
                    error: {
                      message,
                      codexErrorInfo: {
                        responseTooManyFailedAttempts: { httpStatusCode: notificationStatus },
                      },
                      additionalDetails,
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: {
                      ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                      error: {
                        message,
                        codexErrorInfo: {
                          responseTooManyFailedAttempts: { httpStatusCode: completionStatus },
                        },
                      },
                    },
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
              text: "Continue.",
              attemptId: RunAttemptId.make(`attempt-exhaustion-status-${name}`),
            }),
          );
          yield* harness.firstTerminal;
          const terminal = harness.terminalEvents()[0];
          assert.equal(terminal?.status, "failed");
          if (terminal?.status !== "failed") return;
          assert.equal(terminal.failure.class, expectedClass);
          assert.equal(terminal.failure.code, "responseTooManyFailedAttempts");
          assert.equal(terminal.threadDisposition, "reusable");
          const notificationClass = notificationStatus === 429 ? "usage_limit" : "provider_error";
          assert.equal(
            terminal.failure.message,
            expectedClass === notificationClass ? additionalDetails : message,
          );
          if (willRetry) assert.equal(terminal.retry?.attempt, 1);
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

  // regression: #28032 an unlisted codexErrorInfo dropped the failed turn/completed
  it.effect("fails the turn when Codex reports an error info the schema does not list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "native-unlisted-error-info";
        const nativeTurnId = "turn-unlisted-error-info";
        const message =
          "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.";
        const error = { message, codexErrorInfo: "modelNotFound", additionalDetails: null };
        const usage = {
          totalTokens: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-unlisted-error-info",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "say hi" }),
            {
              type: "emit_inbound",
              label: "error",
              frame: {
                method: "error",
                params: { threadId: nativeThreadId, turnId: nativeTurnId, willRetry: false, error },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: { ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }), error },
                },
              },
            },
            // Notifications dispatch in order, so this marks turn/completed as handled.
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
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            text: "say hi",
            attemptId: RunAttemptId.make("attempt-unlisted-error-info"),
          }),
        );
        yield* harness.until(
          () =>
            harness.terminalEvents().length > 0 ||
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.tokenUsage != null,
            ),
        );
        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.failure.message, message);
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
  it.effect("terminalizes running command items before turn.terminal on failed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-failed-mid-command"),
            text: FAILED_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        const failedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "failed",
        );
        assert.isAtLeast(failedCommandIndex, 0);
        assert.isAbove(
          terminalIndex,
          failedCommandIndex,
          "failed-turn command terminalization must precede turn.terminal",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
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
  it.effect("captures an MCP app's resource and holds the turn open until it lands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const appCaptured = yield* Deferred.make<OrchestrationV2TurnItem>();
        const harness = yield* makeCodexReplayHarness(mcpAppTranscript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed"
            ? Deferred.succeed(appCaptured, event.turnItem)
            : Effect.void,
        );
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-mcp-app"),
            text: MCP_APP_PROMPT,
          }),
        );
        const item = yield* Deferred.await(appCaptured);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");

        const completedRows = harness.events.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed",
        );
        assert.lengthOf(completedRows, 1);

        assert.equal(item.type, "dynamic_tool");
        const output = item.type === "dynamic_tool" ? (item.output as Record<string, unknown>) : {};
        const reference = readMcpAppReference(output[MCP_APP_OUTPUT_KEY]);
        assert.deepEqual(
          { ...reference, attachmentId: undefined },
          {
            attachmentId: undefined,
            server: "weather",
            tool: "get_weather",
            resourceUri: MCP_APP_RESOURCE,
            csp: { connectDomains: ["https://api.weather.test"] },
          },
        );
        assert.deepEqual(output.result, {
          content: [{ type: "text", text: "Sunny" }],
          structuredContent: { temp: 21 },
        });

        const fileSystem = yield* FileSystem.FileSystem;
        const stored = yield* fileSystem.readFileString(
          resolveAttachmentPathById({
            attachmentsDir: harness.serverConfig.attachmentsDir,
            attachmentId: reference!.attachmentId,
          })!,
        );
        assert.include(stored, "connect-src https://api.weather.test");
        assert.isBelow(stored.indexOf("Content-Security-Policy"), stored.indexOf("<script>"));
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
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
  it.effect("captures the app of a tool call that defers to its form", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const appCaptured = yield* Deferred.make<OrchestrationV2TurnItem>();
        const harness = yield* makeCodexReplayHarness(mcpAppDeferredTranscript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "failed"
            ? Deferred.succeed(appCaptured, event.turnItem)
            : Effect.void,
        );
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-mcp-app-deferred"),
            text: MCP_APP_PROMPT,
          }),
        );
        const item = yield* Deferred.await(appCaptured);

        const output = item.type === "dynamic_tool" ? (item.output as Record<string, unknown>) : {};
        assert.equal(
          readMcpAppReference(output[MCP_APP_OUTPUT_KEY])?.resourceUri,
          MCP_APP_RESOURCE,
        );
        assert.deepEqual(output.result, { ...MCP_APP_DEFERRED_RESULT, isError: true });
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
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
