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
  CODEX_TEST_MODEL_SELECTION,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  RESUME_SCENARIO,
  RESUME_NATIVE_THREAD,
  RESUME_NATIVE_TURN,
  RESUME_CHILD_THREAD,
  RESUME_CHILD_TURN_1,
  RESUME_PROMPT,
  childAgentMessage,
  childTurnCompleted,
  resumeSubagentTranscript,
  lateChildPrefix,
  errorCauseChainText,
  codexReplaySourceTurn,
  nativeThreadId,
  notification,
  request,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("leaves a late child's result to the root's next turn when one is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondPrompt = "Wait for the sub-agent.";
        const secondTurn = "native-codex-resume-root-turn-2";
        const { spawned, rootFinished } = lateChildPrefix();
        // Reuse the preamble's turn/start exchange under the session's next request id.
        const secondTurnStart = codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: secondTurn,
          prompt: secondPrompt,
        })
          .slice(-3)
          .map((entry) =>
            entry.type !== "runtime_exit" &&
            typeof entry.frame === "object" &&
            entry.frame !== null &&
            "id" in entry.frame
              ? { ...entry, frame: { ...entry.frame, id: 4 } }
              : entry,
          );
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...spawned,
              ...rootFinished,
              ...secondTurnStart,
              childAgentMessage({
                id: "child-late-answer",
                text: "CHILD_DURING_SECOND_TURN",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
              {
                type: "emit_inbound",
                label: "turn/completed/root-2",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: RESUME_NATIVE_THREAD,
                    turn: makeCodexReplayTurn({ id: secondTurn, status: "completed" }),
                  },
                },
              },
            ],
          }),
        );

        const turnInput = (index: number, text: string) =>
          Effect.gen(function* () {
            return {
              ...makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`attempt-codex-active-root-${index}`),
                text,
              }),
              runOrdinal: index,
              providerTurnOrdinal: index,
            };
          });
        yield* harness.runtime.startTurn(yield* turnInput(1, RESUME_PROMPT));
        yield* harness.awaitTerminal(1);
        yield* harness.runtime.startTurn(yield* turnInput(2, secondPrompt));
        yield* harness.awaitTerminal(2);
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.result, "CHILD_DURING_SECOND_TURN");
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
  it.effect.each(["model/rerouted"] as const)(
    "keeps %s child metadata when an older lookup finishes later",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseMetadata = yield* Deferred.make<void>();
          const observed = yield* Deferred.make<void>();
          const model = "gpt-5.6-sol";
          const notification: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method,
              params: {
                threadId: RESUME_CHILD_THREAD,
                turnId: RESUME_CHILD_TURN_1,
                fromModel: "gpt-6-astra",
                toModel: model,
                reason: "highRiskCyberActivity",
              },
            },
          };
          const initialSettings: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method: "thread/settings/updated",
              params: {
                threadId: RESUME_CHILD_THREAD,
                threadSettings: {
                  model: "gpt-6-astra",
                  effort: "low",
                  serviceTier: "ultrafast",
                  modelProvider: "openai",
                  cwd: "/workspace",
                  approvalPolicy: "never",
                  approvalsReviewer: "auto_review",
                  collaborationMode: { mode: "default", settings: { model: "gpt-6-astra" } },
                  sandboxPolicy: { type: "dangerFullAccess" },
                },
              },
            },
          };
          const harness = yield* makeCodexReplayHarness(
            {
              ...resumeSubagentTranscript,
              entries: resumeSubagentTranscript.entries.flatMap((entry) =>
                entry.type === "emit_inbound" && entry.label === "turn/completed/root"
                  ? [entry, initialSettings, notification]
                  : [entry],
              ),
            },
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(observed, undefined)
                : Effect.void,
            undefined,
            (threadId) =>
              Deferred.await(releaseMetadata).pipe(
                Effect.as({ thread: { id: threadId }, model: "gpt-6-astra" }),
              ),
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model-update"),
              text: RESUME_PROMPT,
            }),
          );
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(observed);
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
          yield* Deferred.succeed(releaseMetadata, undefined);
          yield* TestClock.adjust("30 seconds");
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
          assert.deepEqual(harness.subagentUpdates().at(-1)?.subagent.modelSelection?.options, [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "ultrafast" },
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
  it.effect.each(["activity", "spawn", "activity then spawn"] as const)(
    "creates a child from %s without the parent's effort",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const created = yield* Deferred.make<OrchestrationV2AppThread>();
          const completed = yield* Deferred.make<OrchestrationV2Subagent>();
          const activity = {
            type: "subAgentActivity",
            id: "call-codex-resume-spawn",
            kind: "started",
            agentThreadId: RESUME_CHILD_THREAD,
            agentPath: "/root/resume_agent",
          };
          const spawn = {
            type: "collabAgentToolCall",
            id: "call-codex-resume-spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: RESUME_NATIVE_THREAD,
            receiverThreadIds: [RESUME_CHILD_THREAD],
            model: "gpt-5.4",
            reasoningEffort: "high",
            agentsStates: { [RESUME_CHILD_THREAD]: { status: "completed", message: "finished" } },
          };
          const items =
            source === "activity" ? [activity] : source === "spawn" ? [spawn] : [activity, spawn];
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({
              scenario: RESUME_SCENARIO,
              entries: [
                ...codexReplayPreamble({
                  nativeThreadId: RESUME_NATIVE_THREAD,
                  nativeTurnId: RESUME_NATIVE_TURN,
                  prompt: RESUME_PROMPT,
                  effort: "low",
                }),
                ...items.map((item) => ({
                  type: "emit_inbound" as const,
                  frame: {
                    method: "item/completed",
                    params: {
                      item,
                      threadId: RESUME_NATIVE_THREAD,
                      turnId: RESUME_NATIVE_TURN,
                      completedAtMs: 1782622441000,
                    },
                  },
                })),
              ],
            }),
            (event) =>
              event.type === "app_thread.created"
                ? Deferred.succeed(created, event.appThread)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(completed, event.subagent)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn({
            ...makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-effort"),
              text: RESUME_PROMPT,
            }),
            modelSelection: {
              ...CODEX_TEST_MODEL_SELECTION,
              options: [{ id: "reasoningEffort", value: "low" }],
            },
          });
          const child = yield* Deferred.await(created);
          assert.equal(
            child.modelSelection.options?.find(({ id }) => id === "reasoningEffort")?.value,
            source === "spawn" ? "high" : undefined,
          );
          if (source !== "activity") {
            const task = yield* Deferred.await(completed);
            assert.equal(
              task.modelSelection?.options?.find(({ id }) => id === "reasoningEffort")?.value,
              "high",
            );
            assert.lengthOf(
              harness.events.filter((event) => event.type === "app_thread.created"),
              1,
            );
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
  it.effect("preserves a subagent result across a trailing empty final and resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(resumeSubagentTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-resume"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.until(() =>
          harness.subagentUpdates().some((event) => event.subagent.result === "CODEX_FIRST_DONE"),
        );
        assert.lengthOf(
          harness.subagentUpdates().filter((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          1,
        );
        yield* TestClock.adjust("100 millis");
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const settledUpdates = harness.subagentUpdates();
        const firstCompletion = settledUpdates[settledUpdates.length - 1];
        assert.equal(firstCompletion?.subagent.status, "completed");
        assert.equal(firstCompletion?.subagent.result, "CODEX_FIRST_DONE");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        const settledUpdateCount = settledUpdates.length;

        yield* TestClock.adjust("30 seconds");
        yield* harness.until(() => harness.subagentUpdates().length > settledUpdateCount);
        const reopened = harness.subagentUpdates()[settledUpdateCount];
        assert.equal(reopened?.subagent.status, "running");
        assert.equal(DateTime.toEpochMillis(reopened!.subagent.startedAt!), 1782622470000);
        assert.isNull(reopened!.subagent.completedAt);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("30 seconds");
        yield* harness.until(() => {
          const updates = harness.subagentUpdates();
          const latest = updates[updates.length - 1];
          return (
            latest !== undefined &&
            latest.subagent.status === "completed" &&
            latest.subagent.result === "CODEX_RESUME_DONE"
          );
        });
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
        // The first child turn finished inside the root turn; only the resume wakes it.
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "CODEX_RESUME_DONE");
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
  it.effect.each([
    ["shutdown", "cancelled"],
    ["activity-completed", "completed"],
    ["late-activity-completed", "completed"],
    ["stale-running", "completed"],
    ["duplicate-completed", "completed"],
  ] as const)(
    "normalizes subagent %s without losing its lifecycle",
    ([nativeStatus, expectedStatus]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* Deferred.make<void>();
          const firstCompletion = yield* Deferred.make<void>();
          const stateEntry = (
            status: string,
            id: string,
          ): Extract<CodexReplay.CodexAppServerReplayEntry, { type: "emit_inbound" }> => ({
            type: "emit_inbound",
            label: id,
            frame: {
              method: "item/completed",
              params: {
                threadId: RESUME_NATIVE_THREAD,
                turnId: RESUME_NATIVE_TURN,
                item: {
                  type: "collabAgentToolCall",
                  id,
                  tool: "listAgents",
                  status: "completed",
                  senderThreadId: RESUME_NATIVE_THREAD,
                  receiverThreadIds: [RESUME_CHILD_THREAD],
                  agentsStates: { [RESUME_CHILD_THREAD]: { status, message: null } },
                },
              },
            },
          });
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...codexReplayPreamble({
              nativeThreadId: RESUME_NATIVE_THREAD,
              nativeTurnId: RESUME_NATIVE_TURN,
              prompt: RESUME_PROMPT,
            }),
            resumeSubagentTranscript.entries.find(
              (e) =>
                e.type === "emit_inbound" && e.label === "item/completed/subAgentActivity-started",
            )!,
          ];
          if (nativeStatus === "late-activity-completed") {
            entries.push(
              resumeSubagentTranscript.entries.find(
                (e) => e.type === "emit_inbound" && e.label === "turn/completed/root",
              )!,
            );
          }
          if (nativeStatus === "activity-completed" || nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "activity-done",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "subAgentActivity",
                    id: "activity-done",
                    kind: "completed",
                    agentThreadId: RESUME_CHILD_THREAD,
                    agentPath: "/root/resume_agent",
                  },
                },
              },
            });
          } else if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            entries.push(stateEntry("completed", "child-completed"), {
              ...stateEntry(
                nativeStatus === "stale-running" ? "running" : "completed",
                "trailing-snapshot",
              ),
              afterMs: 100,
            });
          } else {
            entries.push(stateEntry(nativeStatus, "status-update"));
          }
          if (nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "late-marker",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_CHILD_THREAD,
                  turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "inProgress" }),
                },
              },
            });
          } else {
            entries.push({
              type: "emit_inbound",
              label: "marker",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "agentMessage",
                    id: "marker",
                    text: "LIFECYCLE_MARKER",
                    phase: "final_answer",
                    memoryCitation: null,
                  },
                },
              },
            });
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: `subagent-${nativeStatus}`, entries }),
            (event) =>
              (event.type === "message.updated" && event.message.text === "LIFECYCLE_MARKER") ||
              (nativeStatus === "late-activity-completed" &&
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === RESUME_CHILD_TURN_1)
                ? Deferred.succeed(marker, undefined)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(firstCompletion, undefined)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`subagent-${nativeStatus}`),
              text: RESUME_PROMPT,
            }),
          );
          if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            yield* Deferred.await(firstCompletion);
            yield* TestClock.adjust("100 millis");
          }
          yield* Deferred.await(marker);
          const latest = harness.subagentUpdates().at(-1)!.subagent;
          assert.equal(latest.status, expectedStatus);
          if (nativeStatus === "duplicate-completed") {
            const first = harness.subagentUpdates().find((e) => e.subagent.status === "completed")!;
            assert.equal(
              DateTime.toEpochMillis(latest.completedAt!),
              DateTime.toEpochMillis(first.subagent.completedAt!),
            );
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
  it.effect("fails honestly when rolling back a legacy Codex thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "legacy-rollback-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "legacy-rollback-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-legacy-rollback",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/read",
            frame: {
              id: 3,
              method: "thread/read",
              params: { threadId: nativeThreadId, includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/read",
            frame: {
              id: 3,
              result: { thread: { id: nativeThreadId, historyMode: "legacy" } },
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-legacy-rollback"),
            appRunOrdinal: 1,
            providerTurn: firstTurn,
          },
          providerThreadTurns: [firstTurn, secondTurn],
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(
        errorCauseChainText(error),
        "legacy",
        "legacy rollback must surface an honest unsupported-history failure",
      );
      assert.notInclude(
        outbound,
        "thread/rollback",
        "thread/rollback must not be sent to a legacy Codex thread",
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
});
