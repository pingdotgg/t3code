import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  CommandId,
  ThreadId,
} from "@t3tools/contracts";
import { Duration, Effect, Fiber, Ref, Schema, Stream } from "effect";
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
    case "message.dispatch":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.reorder":
    case "runtime-request.respond":
    case "checkpoint.rollback":
    case "provider.switch":
      return [command.threadId];
    case "thread.fork":
      return command.source.type === "run"
        ? [command.source.threadId, command.targetThreadId]
        : [command.targetThreadId];
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
        attemptsRemaining = 1_000,
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
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `respond_to_next_runtime_request:${threadId}`,
            });
          }
          yield* Effect.yieldNow;
          return yield* waitForPendingRuntimeRequest(threadId, attemptsRemaining - 1);
        });

      const waitForThreadIdle = (
        threadId: ThreadId,
        attemptsRemaining = 1_000,
      ): Effect.Effect<void, OrchestratorV2Error | OrchestratorV2ScenarioStepError, never> =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          if (!hasActiveRun(projection)) {
            return;
          }
          if (attemptsRemaining <= 0) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_thread_idle:${threadId}`,
            });
          }
          yield* Effect.yieldNow;
          return yield* waitForThreadIdle(threadId, attemptsRemaining - 1);
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

      const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
      for (const threadId of collectProjectionThreadIds(scenario)) {
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
      };
    }),
  );
}
