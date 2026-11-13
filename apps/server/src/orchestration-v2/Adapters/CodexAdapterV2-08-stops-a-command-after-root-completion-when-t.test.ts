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
  encodeReplayTranscriptJson,
  decodeReplayTranscriptJson,
  encodeStringJson,
  CODEX_TEST_MODEL_SELECTION,
  makeCodexTestTurnInput,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  BG_PROMPT,
  backgroundExecTranscript,
  backgroundStopCases,
  makeBackgroundStopTranscript,
  INTERRUPT_CHILD_COMMAND_ITEM,
  INTERRUPT_LATE_CHILD_NATIVE_TURN,
  INTERRUPT_COMMAND,
  INTERRUPT_COMMAND_TWO,
  INTERRUPT_PROMPT,
  interruptMidCommandTranscript,
  interruptSubagentCommandTranscript,
  assertChildProviderTerminalBeforeRoot,
  interruptLateSubagentTurnTranscript,
  interruptSubagentTurnAfterStopTranscript,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect.each(backgroundStopCases)(
    "stops a command after root completion when termination returns %s",
    (terminated) => {
      const stillRunning = terminated === "still_running";
      const transcript = makeBackgroundStopTranscript(terminated);
      return Effect.scoped(
        Effect.gen(function* () {
          const stopped = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? Deferred.succeed(stopped, undefined)
              : Effect.void,
          );
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-stop"),
              text: BG_PROMPT,
            }),
          );
          yield* harness.firstTerminal;
          const terminal = harness.terminalEvents()[0]!;
          assert.equal(terminal.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.isFalse(
            yield* harness.runtime.hasPendingBackgroundWorkForThread!({
              ...harness.providerThread,
              id: ProviderThreadId.make("unrelated-provider-thread"),
            }),
          );
          if (stillRunning) {
            const failed = yield* harness.runtime
              .interruptTurn({
                providerThread: harness.providerThread,
                providerTurnId: terminal.providerTurnId,
                requestRuntimeRestart: true,
              })
              .pipe(Effect.exit);
            assert.equal(failed._tag, "Failure");
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
          }
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: stillRunning
              ? ProviderTurnId.make("later-completed-turn")
              : terminal.providerTurnId,
            requestRuntimeRestart: true,
          });
          yield* Deferred.await(stopped);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
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
      );
    },
  );
  it.effect("stops a completed run's background command without a client-supplied run", () => {
    const transcript = makeBackgroundStopTranscript(true);
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bg-stop-workspace-" });
        const localTranscript = yield* decodeReplayTranscriptJson(
          (yield* encodeReplayTranscriptJson(transcript)).replaceAll(
            yield* encodeStringJson("/workspace"),
            yield* encodeStringJson(cwd),
          ),
        );
        const replayDriver = yield* CodexReplay.makeReplayDriver(localTranscript);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        assert.equal(
          Number(yield* spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd }))),
          0,
        );
        assert.equal(
          Number(
            yield* spawner.exitCode(
              ChildProcess.make(
                "git",
                [
                  "-c",
                  "user.name=Test",
                  "-c",
                  "user.email=test@example.com",
                  "commit",
                  "--allow-empty",
                  "--quiet",
                  "-m",
                  "Initial commit",
                ],
                { cwd },
              ),
            ),
          ),
          0,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop"),
            threadId,
            projectId: ProjectId.make("project:background-stop"),
            title: "Background stop",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const waiting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "run.updated" && event.payload.status === "waiting",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop"),
            threadId,
            messageId: MessageId.make("message:background-stop"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          assert.isNull((yield* Ref.get(replayDriver.state)).failure);
          yield* Fiber.join(waiting);
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.at(-1)!;
          assert.equal(run.status, "completed");
          assert.equal(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks?.length,
            1,
          );
          const stopped = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.type === "command_execution" &&
                event.payload.status === "interrupted",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-background-command"),
            threadId,
          });
          yield* worker.drain();
          yield* Fiber.join(stopped);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "completed",
          );
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "codex-background-stop", runtimePolicyOverride: { cwd } },
              CodexAdapterV2Testkit.layer({
                transcript: localTranscript,
                driver: replayDriver,
              }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
  });
  it.effect("Stop ends a background command no Codex process tracks any more", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bg-stale-workspace-" });
        const staleTranscript = makeCodexReplayTranscript({
          scenario: "codex-bg-stop-untracked",
          entries: [
            ...backgroundExecTranscript.entries.slice(0, -1),
            { type: "runtime_exit", status: "success" },
          ],
        });
        const localTranscript = yield* decodeReplayTranscriptJson(
          (yield* encodeReplayTranscriptJson(staleTranscript)).replaceAll(
            yield* encodeStringJson("/workspace"),
            yield* encodeStringJson(cwd),
          ),
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        for (const args of [
          ["init", "--quiet"],
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial commit",
          ],
        ]) {
          assert.equal(Number(yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }))), 0);
        }
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop-untracked");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop-untracked"),
            threadId,
            projectId: ProjectId.make("project:background-stop-untracked"),
            title: "Background stop untracked",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop-untracked"),
            threadId,
            messageId: MessageId.make("message:background-stop-untracked"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(settled);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadShell(threadId);
          assert.deepEqual(
            before?.pendingBackgroundTasks?.map((task) => task.kind),
            ["command"],
            "the thread still shows the command the gone process never finished",
          );
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-background-untracked"),
            threadId,
            runId: run.id,
            holdQueue: true,
          });
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.turnItems.flatMap((item) =>
              item.type === "command_execution" ? [item.status] : [],
            ),
            ["interrupted"],
          );
          assert.equal(projection.runs.at(-1)?.status, "completed");
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "codex-background-stop-untracked", runtimePolicyOverride: { cwd } },
              CodexAdapterV2Testkit.layer({ transcript: localTranscript }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  );
  it.effect("contains commands that start before and after the interrupt response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-mid-command"),
            text: INTERRUPT_PROMPT,
          }),
        );

        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              event.turnItem.status === "running",
          ),
        );

        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(terminalIndex, 0);

        let lastCommandBeforeTerminal:
          | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
          | undefined;
        for (let index = 0; index < terminalIndex; index++) {
          const event = harness.events[index];
          if (event?.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
            lastCommandBeforeTerminal = event;
          }
        }
        assert.isDefined(lastCommandBeforeTerminal);
        assert.equal(lastCommandBeforeTerminal.turnItem.status, "interrupted");
        assert.isNotNull(lastCommandBeforeTerminal.turnItem.completedAt);

        const interruptedCommandsBeforeTerminal = harness.events
          .slice(0, terminalIndex)
          .flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? [event.turnItem.input]
              : [],
          )
          .sort();
        assert.deepEqual(
          interruptedCommandsBeforeTerminal,
          [INTERRUPT_COMMAND, INTERRUPT_COMMAND_TWO].sort(),
        );

        const interruptedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted",
        );
        assert.isAbove(
          terminalIndex,
          interruptedCommandIndex,
          "command terminalization must precede turn.terminal",
        );

        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);

        const postTerminalCommandUpdates = harness.events.filter(
          (event, index) =>
            index > terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution",
        );
        assert.lengthOf(
          postTerminalCommandUpdates,
          0,
          "late item/completed after interrupt must not project",
        );

        const commandUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > => event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isAtLeast(commandUpdates.length, 2, "start + interrupt terminalization");
        assert.equal(commandUpdates[commandUpdates.length - 1]?.turnItem.status, "interrupted");
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
  it.effect("contains descendant commands and keeps Stop authoritative", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-command"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
              event.turnItem.status === "running",
          ),
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const childCommandUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM,
        );
        assert.equal(childCommandUpdates.at(-1)?.turnItem.status, "interrupted");
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
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
  it.effect("interrupts descendants that start after the initial Stop snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
              event.turnItem.status === "running",
          ),
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
          ),
        );
        yield* Fiber.join(interruptFiber);

        yield* harness.awaitTerminal(1);
        const lateChildUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
        );
        assert.equal(lateChildUpdates.at(-1)?.providerTurn.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
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
  it.effect(
    "keeps reading notifications while interrupting a child turn that starts after Stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(interruptSubagentTurnAfterStopTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-turn-after-stop"),
              text: INTERRUPT_PROMPT,
            }),
          );
          yield* harness.until(() =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          );
          const providerTurnId = harness.events.find(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "provider_turn.updated" }
            > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
          )?.providerTurn.id;
          assert.isDefined(providerTurnId);

          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          });
          yield* harness.awaitTerminal(1);

          // The TestClock never reaches the interrupt's timeout, so this arrives only
          // if the reader is free to read the interrupt response and the frame after it.
          yield* harness.until(() =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.status === "paused",
            ),
          );
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
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
