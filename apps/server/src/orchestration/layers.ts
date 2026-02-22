import path from "node:path";

import { Effect, Layer } from "effect";

import { OrchestrationEventRepository } from "../persistence/Services/OrchestrationEvents";
import { makeSqliteOrchestrationEventRepositoryLive } from "../persistence/Layers/OrchestrationEvents";
import { OrchestrationEngine } from "./engine";
import { OrchestrationConfig, OrchestrationEngineService } from "./services";

export const OrchestrationEventRepositoryLive = Layer.unwrapEffect(
  Effect.map(OrchestrationConfig, ({ stateDir }) => {
    const dbPath = path.join(stateDir, "orchestration.sqlite");
    return makeSqliteOrchestrationEventRepositoryLive(dbPath);
  }),
);

export const OrchestrationEngineLive = Layer.scoped(
  OrchestrationEngineService,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const eventRepository = yield* OrchestrationEventRepository;
      const engine = new OrchestrationEngine(eventRepository);
      yield* Effect.promise(() => engine.start());
      return engine;
    }),
    (engine) => Effect.promise(() => engine.stop()),
  ),
);

export const OrchestrationLive = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationEventRepositoryLive),
);
