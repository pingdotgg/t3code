import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Run,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  CommandId,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { OrchestratorV2, type OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

export type OrchestratorV2ScenarioStep =
  | {
      readonly type: "dispatch";
      readonly command: OrchestrationV2Command;
      readonly await?: boolean;
      readonly key?: string;
    }
  | {
      readonly type: "advance_clock";
      readonly duration: Duration.Input;
    }
  | {
      readonly type: "await";
      readonly key: string;
    }
  | {
      readonly type: "await_all";
    }
  | {
      readonly type: "await_thread_idle";
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "await_run_steerable";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
    }
  | {
      readonly type: "await_run_status";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly status: OrchestrationV2Run["status"];
    }
  | {
      readonly type: "await_run_turn_item";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly itemType: OrchestrationV2TurnItem["type"];
    }
  | {
      readonly type: "release_replay_gate_after_waiting";
      readonly label: string;
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
    }
  | {
      readonly type: "release_replay_gate";
      readonly label: string;
    }
  | {
      readonly type: "capture_shell_snapshot";
      readonly key: string;
    }
  | {
      readonly type: "respond_to_next_runtime_request";
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly decision?: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
    };

export interface OrchestratorV2Scenario {
  readonly name: string;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps?: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds?: ReadonlyArray<ThreadId>;
}

export interface OrchestratorV2ScenarioResult {
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
  readonly domainEvents: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly projections: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
  readonly shellSnapshot: OrchestrationV2ThreadShellSnapshot;
  readonly capturedShellSnapshots: ReadonlyMap<string, OrchestrationV2ThreadShellSnapshot>;
}

export class OrchestratorV2ScenarioStepError extends Schema.TaggedErrorClass<OrchestratorV2ScenarioStepError>()(
  "OrchestratorV2ScenarioStepError",
  {
    scenario: Schema.String,
    step: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid orchestrator scenario step ${this.step} in ${this.scenario}.`;
  }
}

function commandThreadIds(command: OrchestrationV2Command): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.title.regeneration.complete":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "checkpoint.rollback":
    case "provider.switch":
      return [command.threadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
      return [command.parentThreadId];
    case "thread.fork":
    case "thread.merge_back":
      return [command.sourceThreadId, command.targetThreadId];
  }
}

function scenarioSteps(
  scenario: OrchestratorV2Scenario,
): ReadonlyArray<OrchestratorV2ScenarioStep> {
  return (
    scenario.steps ??
    scenario.commands.map((command) => ({
      type: "dispatch" as const,
      command,
      await: true,
    }))
  );
}

function scenarioCommands(scenario: OrchestratorV2Scenario): ReadonlyArray<OrchestrationV2Command> {
  return scenarioSteps(scenario).flatMap((step) =>
    step.type === "dispatch" ? [step.command] : [],
  );
}

const findPendingRuntimeRequest = (projection: OrchestrationV2ThreadProjection) =>
  projection.runtimeRequests.find((request) => request.status === "pending");

const hasActiveRun = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.some((run) =>
    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
  );

const SCENARIO_WAIT_ATTEMPTS = 10_000;
// Iterations count event-loop turns, not time: while async work (git
// subprocesses, fixture IO) is in flight the loop is idle and the counter
// burns at full speed on slow runners. A wait is exhausted only once BOTH
// the iteration budget and this wall-clock deadline are spent.
const SCENARIO_WAIT_DEADLINE_MS = 60_000;
const scenarioWaitDeadline = () => performance.now() + SCENARIO_WAIT_DEADLINE_MS;
const scenarioWaitExhausted = (attemptsRemaining: number, deadlineAt: number) =>
  attemptsRemaining <= 0 && performance.now() >= deadlineAt;

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

function collectProjectionThreadIds(scenario: OrchestratorV2Scenario): ReadonlyArray<ThreadId> {
  if (scenario.projectionThreadIds) {
    return scenario.projectionThreadIds;
  }

  const ids = new Set<ThreadId>();
  for (const command of scenarioCommands(scenario)) {
    for (const threadId of commandThreadIds(command)) {
      ids.add(threadId);
    }
  }
  return Array.from(ids);
}

export function runOrchestratorV2Scenario(
  scenario: OrchestratorV2Scenario,
  options: {
    readonly replayGate?: ProviderReplayGate;
  } = {},
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  OrchestratorV2Error | OrchestratorV2ScenarioStepError,
  OrchestratorV2
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const storedEventGroups: Array<ReadonlyArray<OrchestrationV2StoredEvent>> = [];
      const observedStoredEvents = yield* Ref.make<Array<OrchestrationV2StoredEvent>>([]);
      yield* orchestrator.streamStoredEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(observedStoredEvents, (existing) => [...existing, event]),
        ),
        Effect.forkScoped,
      );
      const backgroundDispatches = new Map<
        string,
        Fiber.Fiber<ReadonlyArray<OrchestrationV2StoredEvent>, OrchestratorV2Error>
      >();
      const capturedShellSnapshots = new Map<string, OrchestrationV2ThreadShellSnapshot>();
      let anonymousBackgroundDispatchIndex = 0;

      const awaitDispatch = (key: string) =>
        Effect.gen(function* () {
          const fiber = backgroundDispatches.get(key);
          if (!fiber) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await:${key}`,
            });
          }
          const events = yield* Fiber.join(fiber);
          backgroundDispatches.delete(key);
          storedEventGroups.push(events);
        });

      const waitForPendingRuntimeRequest = (
        threadId: ThreadId,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<
        OrchestrationV2RuntimeRequest,
        OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const request = findPendingRuntimeRequest(projection);
          if (request !== undefined) {
            return request;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            const runState = projection.runs.map((run) => `${run.id}:${run.status}`).join(",");
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `respond_to_next_runtime_request:${threadId}:runs=${runState}:providerTurns=${projection.providerTurns.length}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForPendingRuntimeRequest(threadId, attemptsRemaining - 1, deadlineAt);
        });

      const waitForThreadIdle = (
        threadId: ThreadId,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          if (!hasActiveRun(projection)) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            const activeRuns = projection.runs
              .filter((run) =>
                ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
              )
              .map((run) => `${run.id}:${run.status}`)
              .join(",");
            const pendingRequests = projection.runtimeRequests
              .filter((request) => request.status === "pending")
              .map((request) => `${request.id}:${request.kind}`)
              .join(",");
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_thread_idle:${threadId}:runs=${activeRuns}:requests=${pendingRequests}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForThreadIdle(threadId, attemptsRemaining - 1, deadlineAt);
        });

      const waitForRunSteerable = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          const providerTurn = projection.providerTurns.find(
            (candidate) =>
              run?.activeAttemptId !== null &&
              candidate.runAttemptId === run?.activeAttemptId &&
              candidate.status === "running",
          );
          if (run?.status === "running" && providerTurn !== undefined) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_steerable:${runId}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunSteerable(threadId, runId, attemptsRemaining - 1, deadlineAt);
        });

      const waitForRunStatus = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        status: OrchestrationV2Run["status"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (run?.status === status) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_status:${runId}:${status}:actual=${run?.status ?? "missing"}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunStatus(
            threadId,
            runId,
            status,
            attemptsRemaining - 1,
            deadlineAt,
          );
        });

      const waitForRunTurnItem = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        itemType: OrchestrationV2TurnItem["type"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const hasTurnItem = projection.turnItems.some(
            (item) => item.runId === runId && item.type === itemType,
          );
          if (hasTurnItem) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_turn_item:${runId}:${itemType}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunTurnItem(
            threadId,
            runId,
            itemType,
            attemptsRemaining - 1,
            deadlineAt,
          );
        });

      const releaseReplayGateAfterWaiting = (
        label: string,
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run?.providerThreadId,
          );
          const pendingTaskCount = providerThread?.pendingBackgroundTasks?.length ?? 0;
          const gateReached = options.replayGate?.hasReached(label) ?? false;
          if (
            gateReached &&
            run?.status === "completed" &&
            providerThread !== undefined &&
            pendingTaskCount > 0
          ) {
            options.replayGate?.release(label);
            yield* waitForProviderBackgroundTasksCleared(threadId, providerThread.id);
            return;
          }
          if (attemptsRemaining <= 0) {
            options.replayGate?.release(label);
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `release_replay_gate_after_waiting:${label}:reached=${gateReached}:run=${run?.status ?? "missing"}:providerThread=${run?.providerThreadId ?? "missing"}:pending=${pendingTaskCount}`,
            });
          }
          yield* yieldToRuntime;
          return yield* releaseReplayGateAfterWaiting(
            label,
            threadId,
            runId,
            attemptsRemaining - 1,
          );
        });

      const waitForProviderBackgroundTasksCleared = (
        threadId: ThreadId,
        providerThreadId: NonNullable<OrchestrationV2Run["providerThreadId"]>,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === providerThreadId,
          );
          const hasPendingTasks = (providerThread?.pendingBackgroundTasks?.length ?? 0) > 0;
          if (!hasPendingTasks && providerThread?.status === "idle") {
            return;
          }
          if (attemptsRemaining <= 0) {
            const providerState = projection.providerThreads
              .map(
                (candidate) =>
                  `${candidate.id}:${candidate.status}:pending=${candidate.pendingBackgroundTasks?.length ?? 0}`,
              )
              .join(",");
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_provider_background_tasks_cleared:${threadId}:target=${providerThreadId}:providers=${providerState}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForProviderBackgroundTasksCleared(
            threadId,
            providerThreadId,
            attemptsRemaining - 1,
          );
        });

      const releaseReplayGate = (
        label: string,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
      ): Effect.Effect<void, OrchestratorV2ScenarioStepError> =>
        Effect.gen(function* () {
          if (options.replayGate?.hasReached(label) ?? false) {
            options.replayGate?.release(label);
            return;
          }
          if (attemptsRemaining <= 0) {
            options.replayGate?.release(label);
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `release_replay_gate:${label}:reached=false`,
            });
          }
          yield* yieldToRuntime;
          return yield* releaseReplayGate(label, attemptsRemaining - 1);
        });

      for (const step of scenarioSteps(scenario)) {
        switch (step.type) {
          case "dispatch": {
            if (step.await ?? true) {
              const result = yield* orchestrator.dispatch(step.command);
              storedEventGroups.push(result.storedEvents);
              break;
            }

            anonymousBackgroundDispatchIndex += 1;
            const key = step.key ?? `dispatch:${anonymousBackgroundDispatchIndex}`;
            backgroundDispatches.set(
              key,
              yield* orchestrator.dispatch(step.command).pipe(
                Effect.map((result) => result.storedEvents),
                Effect.forkScoped,
              ),
            );
            break;
          }
          case "advance_clock":
            yield* TestClock.adjust(step.duration);
            break;
          case "await":
            yield* awaitDispatch(step.key);
            break;
          case "await_all":
            for (const key of Array.from(backgroundDispatches.keys())) {
              yield* awaitDispatch(key);
            }
            break;
          case "await_thread_idle":
            yield* waitForThreadIdle(step.threadId);
            break;
          case "await_run_steerable":
            yield* waitForRunSteerable(step.threadId, step.runId);
            break;
          case "await_run_status":
            yield* waitForRunStatus(step.threadId, step.runId, step.status);
            break;
          case "await_run_turn_item":
            yield* waitForRunTurnItem(step.threadId, step.runId, step.itemType);
            break;
          case "release_replay_gate_after_waiting":
            yield* releaseReplayGateAfterWaiting(step.label, step.threadId, step.runId);
            break;
          case "release_replay_gate":
            yield* releaseReplayGate(step.label);
            break;
          case "capture_shell_snapshot":
            capturedShellSnapshots.set(step.key, yield* orchestrator.getShellSnapshot());
            break;
          case "respond_to_next_runtime_request": {
            const request = yield* waitForPendingRuntimeRequest(step.threadId);
            const result = yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: step.commandId,
              threadId: step.threadId,
              requestId: request.id,
              ...(step.decision === undefined ? {} : { decision: step.decision }),
              ...(step.answers === undefined ? {} : { answers: step.answers }),
            });
            storedEventGroups.push(result.storedEvents);
            break;
          }
        }
      }

      for (const key of Array.from(backgroundDispatches.keys())) {
        yield* awaitDispatch(key);
      }

      const shellSnapshot = yield* orchestrator.getShellSnapshot();
      const projectionThreadIds = new Set(collectProjectionThreadIds(scenario));
      for (const thread of shellSnapshot.threads) {
        projectionThreadIds.add(thread.id);
      }
      const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
      for (const threadId of projectionThreadIds) {
        projections.set(threadId, yield* orchestrator.getThreadProjection(threadId));
      }

      yield* Effect.yieldNow;

      const observedEvents = yield* Ref.get(observedStoredEvents);
      const storedEvents = (
        observedEvents.length > 0 ? observedEvents : storedEventGroups.flat()
      ).toSorted((left, right) => left.sequence - right.sequence);
      return {
        storedEvents,
        domainEvents: storedEvents.map((stored) => stored.event),
        projections,
        shellSnapshot,
        capturedShellSnapshots,
      };
    }),
  );
}
