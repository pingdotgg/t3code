import path from "node:path";

import { Effect, Layer } from "effect";

import { OrchestrationEngine } from "./engine";
import { SqliteEventStore } from "./eventStore";
import {
  OrchestrationConfig,
  OrchestrationEngineService,
  OrchestrationEventStoreService,
} from "./services";

export const OrchestrationEventStoreLive = Layer.effect(
  OrchestrationEventStoreService,
  Effect.map(OrchestrationConfig, ({ stateDir }) => {
    const dbPath = path.join(stateDir, "orchestration.sqlite");
    return new SqliteEventStore(dbPath);
  }),
);

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  Effect.map(OrchestrationEventStoreService, (eventStore) => new OrchestrationEngine(eventStore)),
);

export const OrchestrationLive = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);
