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
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  ORPHAN_WAIT_ITEM,
  PERSISTENT_MONITOR_ITEM,
  COMPLETED_WAIT_ITEM,
  ORPHAN_WAIT_PROMPT,
  orphanedDynamicToolTranscript,
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
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect(
    "terminalizes leftover nonpersistent dynamic tools when a completed turn never closes them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const monitorCompleted = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(orphanedDynamicToolTranscript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM &&
            event.turnItem.status === "completed"
              ? Deferred.succeed(monitorCompleted, undefined)
              : Effect.void,
          );
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-orphan-wait"),
              text: ORPHAN_WAIT_PROMPT,
            }),
          );
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");

          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
          const cancelledWait = harness.events.find(
            (event, index) =>
              index < terminalIndex &&
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === ORPHAN_WAIT_ITEM &&
              event.turnItem.status === "cancelled",
          );
          assert.isDefined(cancelledWait);
          assert.isAbove(
            terminalIndex,
            harness.events.indexOf(cancelledWait!),
            "orphaned wait terminalization must precede turn.terminal",
          );

          const completedWaitStatuses = new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === COMPLETED_WAIT_ITEM
                ? [event.turnItem.status]
                : [],
            ),
          );
          assert.isTrue(
            completedWaitStatuses.has("completed"),
            "the wait that received item/completed must stay completed",
          );
          assert.isFalse(
            completedWaitStatuses.has("cancelled"),
            "a completed wait must not be rewritten as cancelled",
          );

          const persistentMonitorStatuses = new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM
                ? [event.turnItem.status]
                : [],
            ),
          );
          assert.isTrue(persistentMonitorStatuses.has("running"));
          assert.isFalse(
            persistentMonitorStatuses.has("cancelled"),
            "persistent monitors must remain running after the root turn completes",
          );
          assert.isTrue(
            yield* harness.hasPendingBackgroundWork,
            "persistent dynamic tools must keep the session residency pin until they complete",
          );

          yield* TestClock.adjust("30 seconds");
          yield* Deferred.await(monitorCompleted);
          const lateMonitorUpdateIndex = harness.events.findIndex(
            (event, index) =>
              index > terminalIndex &&
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM &&
              event.turnItem.status === "completed",
          );
          assert.isAbove(
            lateMonitorUpdateIndex,
            terminalIndex,
            "persistent tool completion must follow turn.terminal",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
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
  it.effect("wakes the parent when a native child finishes after the parent's turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = resumeSubagentTranscript.entries;
        const labelIndex = (label: string) =>
          entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
        const rootCompleted = labelIndex("turn/completed/root");
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
              ...entries.slice(rootCompleted - 1, rootCompleted + 1),
              childAgentMessage({
                id: "child-late-answer",
                text: "NATIVE_CHILD_16900_DONE",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
                afterMs: 60_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);

        yield* TestClock.adjust("60 seconds");
        yield* harness.until(
          () => harness.subagentUpdates().at(-1)?.subagent.result === "NATIVE_CHILD_16900_DONE",
        );
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "NATIVE_CHILD_16900_DONE");
        assert.equal(harness.continuationRequests[0]?.delivery, "message_text");
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
  it.effect.each(["completed", "failed", "interrupted", "starting", "replied-last"] as const)(
    "handles a late native child after the capacity retry %s",
    (parentStatus) =>
      Effect.scoped(
        Effect.gen(function* () {
          const retriedTurnId = "native-capacity-recovered-parent";
          const retrying = yield* Deferred.make<void>();
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...lateChildPrefix().spawned,
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turn: {
                    ...makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "failed" }),
                    error: {
                      message: "Selected model is at capacity.",
                      codexErrorInfo: "serverOverloaded",
                    },
                  },
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "turn/start",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                  collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                },
              },
            },
            ...(parentStatus === "starting" ? [childTurnCompleted(RESUME_CHILD_TURN_1)] : []),
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: {
                  turn: makeCodexReplayTurn({ id: retriedTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turn: makeCodexReplayTurn({ id: retriedTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turn: {
                    ...makeCodexReplayTurn({
                      id: retriedTurnId,
                      status:
                        parentStatus === "starting" || parentStatus === "replied-last"
                          ? "completed"
                          : parentStatus,
                    }),
                    error:
                      parentStatus === "failed"
                        ? { message: "Recovery failed.", codexErrorInfo: "internalServerError" }
                        : null,
                  },
                },
              },
            },
            childAgentMessage({
              id: "child-after-capacity",
              text: "CAPACITY_CHILD_DONE",
              turnId: RESUME_CHILD_TURN_1,
              completedAtMs: 1782622480000,
              afterMs: 60_000,
            }),
            childTurnCompleted(RESUME_CHILD_TURN_1),
          ];
          if (parentStatus === "replied-last") {
            entries.push(...entries.splice(lateChildPrefix().spawned.length + 2, 1));
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: "capacity-late-child", entries }),
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.status === "running"
                ? Deferred.succeed(retrying, undefined)
                : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("capacity-late-child"),
              text: RESUME_PROMPT,
            }),
          );
          yield* Deferred.await(retrying);
          yield* TestClock.adjust("2 seconds");
          if (parentStatus === "interrupted") assert.isEmpty(harness.terminalEvents());
          else {
            yield* harness.awaitTerminal(1);
            const terminal = harness.terminalEvents()[0];
            if (terminal?.status === "failed") assert.isTrue(terminal.childTurnsContinue);
          }
          yield* TestClock.adjust("60 seconds");
          yield* harness.until(
            () => harness.subagentUpdates().at(-1)?.subagent.status === "completed",
          );
          yield* harness.awaitTerminal(1);
          assert.lengthOf(
            harness.continuationRequests,
            parentStatus === "completed" || parentStatus === "replied-last" ? 1 : 0,
          );
          if (parentStatus === "completed" || parentStatus === "replied-last")
            assert.include(harness.continuationRequests[0]?.detail, "CAPACITY_CHILD_DONE");
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
  it.effect("stops native children when capacity retry startup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retrying = yield* Deferred.make<void>();
        const starting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupts: unknown[] = [];
        let starts = 0;
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "capacity-start-fails-stop-child",
            entries: [
              ...lateChildPrefix().spawned,
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: RESUME_NATIVE_THREAD,
                    turn: {
                      ...makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "failed" }),
                      error: { message: "At capacity", codexErrorInfo: "serverOverloaded" },
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "turn/start",
                  params: {
                    threadId: RESUME_NATIVE_THREAD,
                    input: [],
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    summary: "detailed",
                    collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: { id: 4, error: { code: -32603, message: "Start failed" } },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: "turn/interrupt",
                  params: { threadId: RESUME_CHILD_THREAD, turnId: RESUME_CHILD_TURN_1 },
                },
              },
              { type: "emit_inbound", frame: { id: 5, result: {} } },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: RESUME_CHILD_THREAD,
                    turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "interrupted" }),
                  },
                },
              },
            ],
          }),
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "running"
              ? Deferred.succeed(retrying, undefined)
              : Effect.void,
          (method, params) =>
            Effect.gen(function* () {
              if (method === "turn/interrupt") interrupts.push(params);
              if (method === "turn/start" && ++starts === 2) {
                yield* Deferred.succeed(starting, undefined);
                yield* Deferred.await(release);
              }
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("capacity-start-fails-stop-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* Deferred.await(retrying);
        const root = harness.events.find((event) => event.type === "provider_turn.updated");
        assert.equal(root?.type, "provider_turn.updated");
        if (root?.type !== "provider_turn.updated") return;
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.await(starting);
        const stopping = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: root.providerTurn.id,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        assert.lengthOf(interrupts, 1);
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "interrupted");
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
  it.effect("names a late child spawned without a prompt in its wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spawned, rootFinished } = lateChildPrefix();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...spawned.map((entry) =>
                entry.type === "emit_inbound" &&
                entry.label === "item/completed/subAgentActivity-started"
                  ? {
                      ...entry,
                      frame: {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "collabAgentToolCall",
                            id: "call-codex-resume-spawn",
                            tool: "spawnAgent",
                            status: "completed",
                            senderThreadId: RESUME_NATIVE_THREAD,
                            receiverThreadIds: [RESUME_CHILD_THREAD],
                            agentsStates: {},
                          },
                          threadId: RESUME_NATIVE_THREAD,
                          turnId: RESUME_NATIVE_TURN,
                          completedAtMs: 1782622441000,
                        },
                      },
                    }
                  : entry,
              ),
              ...rootFinished,
              childAgentMessage({
                id: "child-late-answer",
                text: "UNPROMPTED_CHILD_DONE",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
                afterMs: 60_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-unprompted-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);
        yield* TestClock.adjust("60 seconds");
        yield* harness.until(() => harness.continuationRequests.length > 0);
        const subagent = harness.subagentUpdates().at(-1)?.subagent;
        assert.equal(subagent?.prompt, "");
        assert.equal(
          harness.continuationRequests[0]?.detail,
          `Subagent completed: ${subagent?.id}\n\nResult:\nUNPROMPTED_CHILD_DONE`,
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
  it.effect("wakes the root only when its direct child finishes, not a grandchild", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const grandchildThread = "native-codex-resume-grandchild-thread";
        const grandchildTurn = "native-codex-resume-grandchild-turn";
        const { spawned, rootFinished } = lateChildPrefix();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...spawned,
              {
                type: "emit_inbound",
                label: "item/completed/grandchild-spawn",
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "subAgentActivity",
                      id: "call-codex-grandchild-spawn",
                      kind: "started",
                      agentThreadId: grandchildThread,
                      agentPath: "/root/resume_agent/grandchild",
                    },
                    threadId: RESUME_CHILD_THREAD,
                    turnId: RESUME_CHILD_TURN_1,
                    completedAtMs: 1782622441500,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/started/grandchild",
                frame: {
                  method: "turn/started",
                  params: {
                    threadId: grandchildThread,
                    turn: makeCodexReplayTurn({ id: grandchildTurn, status: "inProgress" }),
                  },
                },
              },
              ...rootFinished,
              {
                type: "emit_inbound",
                label: "item/completed/grandchild-answer",
                afterMs: 30_000,
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: "grandchild-answer",
                      text: "GRANDCHILD_DONE",
                      phase: "final_answer",
                      memoryCitation: null,
                    },
                    threadId: grandchildThread,
                    turnId: grandchildTurn,
                    completedAtMs: 1782622470000,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed/grandchild",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: grandchildThread,
                    turn: makeCodexReplayTurn({ id: grandchildTurn, status: "completed" }),
                  },
                },
              },
              childAgentMessage({
                id: "child-late-answer",
                text: "CHILD_AFTER_GRANDCHILD",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622500000,
                afterMs: 30_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-grandchild"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);

        yield* TestClock.adjust("30 seconds");
        yield* harness.until(() =>
          harness.subagentUpdates().some((event) => event.subagent.result === "GRANDCHILD_DONE"),
        );
        assert.lengthOf(harness.continuationRequests, 0);

        yield* TestClock.adjust("30 seconds");
        yield* harness.until(() => harness.continuationRequests.length > 0);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "CHILD_AFTER_GRANDCHILD");
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
