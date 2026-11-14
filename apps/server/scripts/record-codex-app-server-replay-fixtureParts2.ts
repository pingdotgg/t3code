import * as NodeOS from "node:os";

import { CODEX_THREAD_CONFIG } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { revertCodexThread } from "../src/provider/CodexThreadRevert.ts";
import { buildCodexInitializeParams } from "../src/provider/CodexProvider.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  PLAN_QUESTIONS_PROMPT,
  PROPOSED_PLAN_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  SIMPLE_PROMPT,
  SUBAGENT_CONTINUE_PARENT_PROMPT,
  SUBAGENT_CONTINUE_PROMPT,
  SUBAGENT_PROMPT,
  SUBAGENT_V2_APPROVAL_PROMPT,
  SUBAGENT_V2_PROMPT,
  SUBAGENT_V2_NESTED_APPROVAL_PROMPT,
  SUBAGENT_V2_NESTED_PROMPT,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
  TODO_LIST_PROMPT,
  TOOL_CALL_WRITE_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  COMMAND_OUTPUT_STREAMING_PROMPT,
  TURN_INTERRUPT_PROMPT,
  WEB_SEARCH_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { codexReplayRecordingOutputRecords } from "./codexReplayRecordingRecords.ts";
import { makeReplayRecorderDeferredRegistry } from "./replayRecorderDeferredRegistry.ts";
import { scenarios } from "./record-codex-app-server-replay-fixtureParts.ts";
import type { Recorder, ReplayRun, ReplayScenario, TurnReplayStep, TurnStartParams } from "./record-codex-app-server-replay-fixture.ts";
import { CODEX_CLIENT_CAPABILITIES, getTurnId, installReplayHandlers, layerCodex, planCollaborationMode, scenarioModel, turnInput } from "./record-codex-app-server-replay-fixture.ts";

export const runReplaySession = Effect.fn("record-codex-app-server-replay-fixture.runReplaySession")(
  function* ({
    scenario,
    run,
    recorder,
  }: {
    readonly scenario: ReplayScenario;
    readonly run: ReplayRun;
    readonly recorder: Recorder;
  }) {
    const startedTurns = yield* makeReplayRecorderDeferredRegistry();
    const completedTurns = yield* makeReplayRecorderDeferredRegistry();
    const startedCommandExecutions = yield* makeReplayRecorderDeferredRegistry();
    let approvalGate: Deferred.Deferred<void> | undefined;
    const getStarted = startedTurns.getOrCreate;
    const getCompletion = completedTurns.getOrCreate;
    const getCommandExecutionStarted = startedCommandExecutions.getOrCreate;
    const startTurn = startedTurns.succeed;
    const completeTurn = completedTurns.succeed;
    const startCommandExecution = startedCommandExecutions.succeed;
    const beforeApprovalResponse = () =>
      approvalGate ? Deferred.await(approvalGate) : Effect.void;
    const model = scenarioModel(scenario);
    const threadRuntimeParams = { cwd: process.cwd(), model, config: CODEX_THREAD_CONFIG };
    const lastTurnIdByThread = new Map<string, string>();
    const runningCommandProcessIds = new Map<string, Map<string, string>>();

    const initializeClient = Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;

      yield* installReplayHandlers({
        client,
        startTurn,
        completeTurn,
        startCommandExecution,
        beforeApprovalResponse,
        runningCommandProcessIds,
      });

      yield* client.request("initialize", {
        clientInfo: buildCodexInitializeParams().clientInfo,
        capabilities: CODEX_CLIENT_CAPABILITIES,
      });

      yield* client.notify("initialized", undefined);

      return client;
    });

    const runTurnStep = Effect.fn("record-codex-app-server-replay-fixture.runTurnStep")(function* (
      client: CodexClient.CodexAppServerClient["Service"],
      threadId: string,
      step: TurnReplayStep,
    ) {
      const turnParams: TurnStartParams = {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        cwd: process.cwd(),
        model,
        summary: "detailed",
        approvalsReviewer: "user",
        ...(run.interactionMode === "plan"
          ? { collaborationMode: planCollaborationMode(model) }
          : {}),
        ...run.turnDefaults,
        ...step.turnOverrides,
        input: turnInput(step.prompt),
        threadId,
      };

      if (step.type === "steeredTurn") {
        approvalGate = yield* Deferred.make<void>();
      }

      const turn = yield* client.request("turn/start", turnParams);
      const turnId = getTurnId(turn);
      const started = yield* getStarted(turnId);
      yield* getCompletion(turnId);

      if (step.type === "steeredTurn") {
        yield* Deferred.await(started);
        yield* client.request("turn/steer", {
          expectedTurnId: turnId,
          input: turnInput(step.steer),
          threadId,
        });
        if (approvalGate) {
          yield* Deferred.succeed(approvalGate, void 0);
          approvalGate = undefined;
        }
      }

      if (step.type === "interruptedTurn") {
        if (step.interruptAfterCommandExecutionStarted === true) {
          const commandExecutionStarted = yield* getCommandExecutionStarted(turnId);
          yield* Deferred.await(commandExecutionStarted);
        } else {
          yield* Effect.sleep(`${step.interruptAfterMs ?? 1_500} millis`);
        }
        yield* client.request("turn/interrupt", {
          threadId,
          turnId,
        });
        for (const processId of runningCommandProcessIds.get(turnId)?.values() ?? []) {
          yield* client.raw.request("thread/backgroundTerminals/terminate", {
            threadId,
            processId,
          });
        }
      }

      const completed = yield* getCompletion(turnId);
      yield* Deferred.await(completed);
      lastTurnIdByThread.set(threadId, turnId);
    });

    if (scenario.name === "provider_thread_resume") {
      const firstStep = run.steps[0];
      const secondStep = run.steps[1];
      if (
        !firstStep ||
        !secondStep ||
        firstStep.type === "rollback" ||
        firstStep.type === "fork" ||
        secondStep.type === "rollback" ||
        secondStep.type === "fork"
      ) {
        throw new Error("provider_thread_resume replay recording requires two turn steps.");
      }

      const firstThread = yield* Effect.gen(function* () {
        const client = yield* initializeClient;
        const thread = yield* client.request("thread/start", threadRuntimeParams);
        yield* runTurnStep(client, thread.thread.id, firstStep);
        return thread;
      }).pipe(
        Effect.provide(
          layerCodex({
            recorder,
          }),
        ),
      );

      yield* recorder.writeRecord({
        type: "runtime_exit",
        status: "success",
      });

      yield* Effect.gen(function* () {
        const client = yield* initializeClient;
        const thread = yield* client.request("thread/resume", {
          threadId: firstThread.thread.id,
          excludeTurns: true,
          ...threadRuntimeParams,
        });
        yield* runTurnStep(client, thread.thread.id, secondStep);
      }).pipe(
        Effect.provide(
          layerCodex({
            recorder,
          }),
        ),
      );
      return;
    }

    if (scenario.name === "thread_rollback_after_restart") {
      const [first, second, rollback, after] = run.steps;
      if (
        first === undefined ||
        second === undefined ||
        rollback?.type !== "rollback" ||
        after === undefined ||
        first.type === "rollback" ||
        first.type === "fork" ||
        second.type === "rollback" ||
        second.type === "fork" ||
        after.type === "rollback" ||
        after.type === "fork"
      ) {
        throw new Error(
          "thread_rollback_after_restart replay recording requires turn, turn, rollback, turn.",
        );
      }

      const threadId = yield* Effect.gen(function* () {
        const client = yield* initializeClient;
        const thread = yield* client.request("thread/start", threadRuntimeParams);
        yield* runTurnStep(client, thread.thread.id, first);
        yield* runTurnStep(client, thread.thread.id, second);
        return thread.thread.id;
      }).pipe(Effect.provide(layerCodex({ recorder })));

      yield* recorder.writeRecord({
        type: "runtime_exit",
        status: "success",
      });

      yield* Effect.gen(function* () {
        const client = yield* initializeClient;
        const resumeParams = { threadId, excludeTurns: true, ...threadRuntimeParams };
        // Fresh app-servers report notLoaded; resume before thread/revert and again on the next turn.
        yield* client.request("thread/read", { threadId, includeTurns: false });
        yield* client.request("thread/resume", resumeParams);
        yield* revertCodexThread(client, threadId, rollback.numTurns);
        yield* client.request("thread/resume", resumeParams);
        yield* runTurnStep(client, threadId, after);
      }).pipe(Effect.provide(layerCodex({ recorder })));
      return;
    }

    yield* Effect.gen(function* () {
      const client = yield* initializeClient;
      const thread = yield* client.request("thread/start", {
        ...threadRuntimeParams,
        config: { ...threadRuntimeParams.config, ...run.threadConfig },
      });
      let activeThreadId = thread.thread.id;
      const threadIds = new Map<string, string>([["source", thread.thread.id]]);

      for (const [stepIndex, step] of run.steps.entries()) {
        if (step.type === "rollback") {
          yield* client.request("thread/read", { threadId: activeThreadId, includeTurns: false });
          yield* revertCodexThread(client, activeThreadId, step.numTurns);
          continue;
        }
        if (step.type === "fork") {
          const sourceThreadId =
            step.from === undefined ? activeThreadId : threadIds.get(step.from);
          if (sourceThreadId === undefined) {
            throw new Error(`Unknown replay thread alias '${step.from}'.`);
          }
          const lastTurnId = lastTurnIdByThread.get(sourceThreadId);
          const forked = yield* client.request("thread/fork", {
            threadId: sourceThreadId,
            ...(lastTurnId === undefined ? {} : { lastTurnId }),
            ...threadRuntimeParams,
          });
          activeThreadId = forked.thread.id;
          if (step.as !== undefined) {
            threadIds.set(step.as, forked.thread.id);
          }
          continue;
        }

        const threadAlias = "thread" in step ? step.thread : undefined;
        const turnThreadId =
          threadAlias === undefined ? activeThreadId : threadIds.get(threadAlias);
        if (turnThreadId === undefined) {
          throw new Error(`Unknown replay thread alias '${threadAlias}'.`);
        }
        yield* runTurnStep(client, turnThreadId, step);
        void stepIndex;
      }
    }).pipe(
      Effect.provide(
        layerCodex({
          recorder,
        }),
      ),
    );
  },
);

