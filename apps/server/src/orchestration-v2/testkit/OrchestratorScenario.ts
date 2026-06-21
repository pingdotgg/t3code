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
      readonly type: "await_run_turn_item";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly itemType: OrchestrationV2TurnItem["type"];
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
    case "thread.metadata.update":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.reorder":
    case "runtime-request.respond":
    case "checkpoint.rollback":
    case "provider.switch":
      return [command.threadId];
    case "delegated_task.request":
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
  projection.runs.some((run) => ["queued", "starting", "running", "waiting"].includes(run.status));

const SCENARIO_WAIT_ATTEMPTS = 10_000;

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
          if (attemptsRemaining <= 0) {
            const runState = projection.runs.map((run) => `${run.id}:${run.status}`).join(",");
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `respond_to_next_runtime_request:${threadId}:runs=${runState}:providerTurns=${projection.providerTurns.length}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForPendingRuntimeRequest(threadId, attemptsRemaining - 1);
        });

      const waitForThreadIdle = (
        threadId: ThreadId,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          if (!hasActiveRun(projection)) {
            return;
          }
          if (attemptsRemaining <= 0) {
            const activeRuns = projection.runs
              .filter((run) => ["queued", "starting", "running", "waiting"].includes(run.status))
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
          return yield* waitForThreadIdle(threadId, attemptsRemaining - 1);
        });

      const waitForRunSteerable = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
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
          if (attemptsRemaining <= 0) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_steerable:${runId}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunSteerable(threadId, runId, attemptsRemaining - 1);
        });

      const waitForRunTurnItem = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        itemType: OrchestrationV2TurnItem["type"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const hasTurnItem = projection.turnItems.some(
            (item) => item.runId === runId && item.type === itemType,
          );
          if (hasTurnItem) {
            return;
          }
          if (attemptsRemaining <= 0) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_turn_item:${runId}:${itemType}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunTurnItem(threadId, runId, itemType, attemptsRemaining - 1);
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
          case "await_run_turn_item":
            yield* waitForRunTurnItem(step.threadId, step.runId, step.itemType);
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
      };
    }),
  );
}
