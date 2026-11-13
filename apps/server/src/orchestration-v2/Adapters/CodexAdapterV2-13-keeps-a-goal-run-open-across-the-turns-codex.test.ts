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
  nativeThreadId,
  objective,
  codexGoal,
  notification,
  request,
  withReplayRequestId_2,
  sessionStart,
  goalTurnInput,
  providerGoals,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  describe("native goals", () => {
    it.effect("keeps a /goal run open across the turns Codex continues on its own", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective, status: "paused" },
              { goal: codexGoal("paused", 0) },
            ),
            ...withReplayRequestId_2(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-1",
                prompt: objective,
                sentPrompt: `Start working toward this goal: ${objective}`,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: codexGoal("active", 0) },
            ),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-1",
              goal: codexGoal("active", 0),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-1", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-2",
              goal: codexGoal("complete", 1200),
            }),
            notification("continuation done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${objective}`));
        yield* harness.firstTerminal;

        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = (nativeTurnId: string) =>
          idAllocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          });
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[providerTurnId("goal-turn-2"), "completed"]],
        );
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? [
                  [
                    event.providerTurn.id,
                    event.providerTurn.runAttemptId,
                    event.providerTurn.ordinal,
                  ],
                ]
              : [],
          ),
          [
            [providerTurnId("goal-turn-1"), RunAttemptId.make("goal-attempt"), 1],
            [providerTurnId("goal-turn-2"), RunAttemptId.make("goal-attempt"), 2],
          ],
        );
        // The goal is set paused until its first turn starts; only the result shows.
        assert.notInclude(providerGoals(harness.events), "paused");
        assert.equal(providerGoals(harness.events).at(-1), "complete");
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
    it.effect("rejects an oversized /goal objective before any goal request", () =>
      Effect.gen(function* () {
        const oversized = "x".repeat(4001);
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: "goal-oversized", entries: sessionStart }),
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const start = yield* harness.runtime
          .startTurn(yield* goalTurnInput(harness, `/goal ${oversized}`))
          .pipe(Effect.result);

        assert.deepEqual(
          requests.filter((method) => method.startsWith("thread/goal/") || method === "turn/start"),
          [],
        );
        assert.equal(start._tag, "Failure");
        if (start._tag === "Failure") {
          const { message } = makeProviderFailure({ cause: start.failure });
          assert.match(message, /4,?001/u);
          assert.match(message, /4,?000/u);
        }
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
    it.effect("sends a /goal objective at the 4000 character limit unchanged", () =>
      Effect.gen(function* () {
        const atLimit = "y".repeat(4000);
        const goal = (status: string) => ({ ...codexGoal(status, 0), objective: atLimit });
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-at-limit",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective: atLimit, status: "paused" },
              { goal: goal("paused") },
            ),
            ...withReplayRequestId_2(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-limit",
                prompt: atLimit,
                sentPrompt: `Start working toward this goal: ${atLimit}`,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: goal("active") },
            ),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-limit",
              goal: goal("complete"),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-limit", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${atLimit}`));
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
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
    it.effect("settles a run held for the next goal turn when Stop arrives in between", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-between-turns",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 10),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-hold-attempt"),
            text: prompt,
          }),
        );
        const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeTurnId: "goal-turn",
        });
        const turnStatuses = () =>
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.id === providerTurnId
              ? [event.providerTurn.status]
              : [],
          );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        assert.deepEqual(turnStatuses(), ["running"]);
        assert.lengthOf(harness.terminalEvents(), 0);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });
        yield* harness.firstTerminal;

        assert.notInclude(requests, "turn/interrupt");
        assert.deepEqual(turnStatuses(), ["running", "completed"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
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
    it.effect("moves a Stop that names an earlier goal turn to the turn Codex continued with", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-after-continuation",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              5,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-b" },
              {},
            ),
            notification("continuation interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-successor-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-a",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
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
    it.effect("pauses a goal Codex does not continue before its run settles", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation-expired",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-expired-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* TestClock.adjust("5 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(providerGoals(harness.events), ["active", "active", "paused"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
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
    it.effect("stops a turn Codex starts while the expiry pause is in flight", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation-during-expiry",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "pause",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 11),
            }),
            notification("late continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            ...request(
              5,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              6,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-2" },
              {},
            ),
            {
              type: "emit_inbound",
              label: "paused",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-race-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        yield* TestClock.adjust("5 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [
            [
              (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                nativeTurnId: "goal-turn",
              }),
              "completed",
            ],
          ],
        );
        assert.equal(providerGoals(harness.events).at(-1), "paused");
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
    it.effect("settles the run when Codex never answers the expiry pause", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-expiry-pause-unanswered",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "pause",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
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
            attemptId: RunAttemptId.make("goal-unanswered-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("10 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
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
});
