import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { Duration, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import { OrchestratorV2, type OrchestratorV2Error } from "../Services/Orchestrator.ts";

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
    };

export interface OrchestratorV2Scenario {
  readonly name: string;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps?: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds?: ReadonlyArray<ThreadId>;
}

export interface OrchestratorV2ScenarioResult {
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
      const domainEventGroups: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
      const backgroundDispatches = new Map<
        string,
        Fiber.Fiber<ReadonlyArray<OrchestrationV2DomainEvent>, OrchestratorV2Error>
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
          domainEventGroups.push(events);
        });

      for (const step of scenarioSteps(scenario)) {
        switch (step.type) {
          case "dispatch": {
            if (step.await ?? true) {
              domainEventGroups.push(yield* orchestrator.dispatch(step.command));
              break;
            }

            anonymousBackgroundDispatchIndex += 1;
            const key = step.key ?? `dispatch:${anonymousBackgroundDispatchIndex}`;
            backgroundDispatches.set(
              key,
              yield* orchestrator.dispatch(step.command).pipe(Effect.forkScoped),
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
        }
      }

      for (const key of Array.from(backgroundDispatches.keys())) {
        yield* awaitDispatch(key);
      }

      const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
      for (const threadId of collectProjectionThreadIds(scenario)) {
        projections.set(threadId, yield* orchestrator.getThreadProjection(threadId));
      }

      return {
        domainEvents: domainEventGroups.flat(),
        projections,
      };
    }),
  );
}
