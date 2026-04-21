import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ProviderReplayTranscript,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestratorV2, type OrchestratorV2Error } from "../Services/Orchestrator.ts";
import {
  ProviderRuntimeTransport,
  type ProviderRuntimeTransportError,
} from "../Services/ProviderRuntimeTransport.ts";
import { makeReplayProviderRuntimeLayer } from "../replay/ReplayProviderRuntime.ts";

export interface OrchestratorV2Scenario {
  readonly name: string;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly projectionThreadIds?: ReadonlyArray<ThreadId>;
  readonly assertReplayComplete?: boolean;
}

export interface OrchestratorV2ReplayScenario extends OrchestratorV2Scenario {
  readonly transcript: ProviderReplayTranscript;
}

export interface OrchestratorV2ScenarioResult {
  readonly domainEvents: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly projections: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
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

function collectProjectionThreadIds(scenario: OrchestratorV2Scenario): ReadonlyArray<ThreadId> {
  if (scenario.projectionThreadIds) {
    return scenario.projectionThreadIds;
  }

  const ids = new Set<ThreadId>();
  for (const command of scenario.commands) {
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
  OrchestratorV2Error | ProviderRuntimeTransportError,
  OrchestratorV2 | ProviderRuntimeTransport
> {
  return Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const runtime = yield* ProviderRuntimeTransport;
    const domainEventGroups = yield* Effect.forEach(scenario.commands, orchestrator.dispatch, {
      concurrency: 1,
    });

    if (scenario.assertReplayComplete ?? true) {
      yield* runtime.assertComplete();
    }

    const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
    for (const threadId of collectProjectionThreadIds(scenario)) {
      projections.set(threadId, yield* orchestrator.getThreadProjection(threadId));
    }

    return {
      domainEvents: domainEventGroups.flat(),
      projections,
    };
  });
}

export function runOrchestratorV2ReplayScenario(
  scenario: OrchestratorV2ReplayScenario,
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  OrchestratorV2Error | ProviderRuntimeTransportError,
  OrchestratorV2
> {
  return runOrchestratorV2Scenario(scenario).pipe(
    Effect.provide(makeReplayProviderRuntimeLayer(scenario.transcript)),
  );
}
