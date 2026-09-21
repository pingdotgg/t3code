import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

/**
 * Supply inert defaults for tests outside the orchestration engine module.
 * Event-stream overrides also drive the scoped subscription by default.
 */
export function makeTestOrchestrationEngine(
  overrides: Partial<OrchestrationEngineShape> = {},
): OrchestrationEngineShape {
  const streamDomainEvents = overrides.streamDomainEvents ?? Stream.empty;
  return OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: () => Effect.die("unused thread replay stats"),
    dispatch: () => Effect.succeed({ sequence: 0 }),
    streamDomainEvents,
    subscribeDomainEvents: Effect.succeed(streamDomainEvents),
    latestSequence: Effect.succeed(0),
    ...overrides,
  });
}
