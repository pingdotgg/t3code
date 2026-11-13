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
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  threadEnvOf,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  nativeThreadId,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("resumes a provider thread without requesting or decoding its history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-resume-metadata";
        const nativeThreadId = `native-${scenario}-thread`;
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused-turn",
          prompt: "unused-prompt",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              label: "thread/resume without an app thread",
              frame: {
                id: 4,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume without an app thread",
              frame: { id: 4, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              label: "thread/resume with an explicit app thread",
              frame: {
                id: 5,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume with an explicit app thread",
              frame: { id: 5, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
          ],
        });
        const resumeThreadEnvs: Array<unknown> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method, params) =>
            Effect.sync(() => {
              if (method === "thread/resume") resumeThreadEnvs.push(threadEnvOf(params));
            }),
        );
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        yield* harness.runtime.resumeThread({
          providerThread: { ...harness.providerThread, appThreadId: null },
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        const explicitThreadId = ThreadId.make(`thread-${scenario}-explicit`);
        yield* harness.runtime.resumeThread({
          threadId: explicitThreadId,
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });

        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
        assert.deepEqual(resumeThreadEnvs, [harness.threadId, undefined, explicitThreadId]);
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

  // regression: #15389 archived native Codex sessions resume via thread/unarchive
  it.effect.each(
    (
      [
        ["recovers archived-session errors", "session saved-thread is archived", 0, ""],
        ["preserves missing-thread errors", "thread not found", 3, "thread not found"],
        [
          "propagates unarchive missing-thread errors",
          "session saved-thread is archived",
          4,
          "thread not found",
        ],
        [
          "does not retry archived errors twice",
          "session saved-thread is archived",
          5,
          "session saved-thread is archived",
        ],
      ] as const
    ).map(([name, resumeError, failAt, finalError]) => ({ name, resumeError, failAt, finalError })),
  )("$name", ({ name, resumeError, failAt, finalError }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "saved-thread";
        const params = {
          threadId: nativeThreadId,
          excludeTurns: true,
          cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
          model: CODEX_TEST_MODEL_SELECTION.model,
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
        };
        const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "unused-turn",
            prompt: "unused-prompt",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            label: "resume archived thread",
            frame: { id: 3, method: "thread/resume", params },
          },
          {
            type: "emit_inbound",
            label: "resume error",
            frame: { id: 3, error: { code: -32600, message: resumeError } },
          },
        ];
        if (failAt !== 3) {
          entries.push(
            {
              type: "expect_outbound",
              label: "unarchive same thread",
              frame: { id: 4, method: "thread/unarchive", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "unarchive result",
              frame:
                failAt === 4
                  ? { id: 4, error: { code: -32600, message: finalError } }
                  : { id: 4, result: { thread: { turns: [{ type: "unknown-history-item" }] } } },
            },
          );
        }
        if (failAt === 0 || failAt === 5) {
          entries.push(
            {
              type: "expect_outbound",
              label: "retry identical resume",
              frame: { id: 5, method: "thread/resume", params },
            },
            {
              type: "emit_inbound",
              label: "retry result",
              frame:
                failAt === 5
                  ? { id: 5, error: { code: -32600, message: finalError } }
                  : {
                      id: 5,
                      result: {
                        thread: {
                          id: nativeThreadId,
                          updatedAt: 1782622450,
                          turns: [{ type: "unknown-history-item" }],
                        },
                      },
                    },
            },
          );
        }
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: name, entries }),
        );
        const resume = harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        if (failAt !== 0) {
          const error = yield* Effect.flip(resume);
          assert.equal(error._tag, "ProviderAdapterResumeThreadError");
          assert.nestedPropertyVal(error, "cause.errorMessage", finalError);
          assert.nestedPropertyVal(
            error,
            "cause.method",
            failAt === 4 ? "thread/unarchive" : "thread/resume",
          );
          assert.nestedPropertyVal(error, "cause.requestId", String(failAt));
          return;
        }
        const resumed = yield* resume;
        assert.equal(resumed.id, harness.providerThread.id);
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.deepEqual(
          resumed.nativeConversationHeadRef,
          harness.providerThread.nativeConversationHeadRef,
        );
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
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
