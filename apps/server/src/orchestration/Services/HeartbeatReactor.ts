/**
 * HeartbeatReactor - Service interface for periodic agent heartbeats.
 *
 * @module HeartbeatReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

/**
 * HeartbeatReactorShape - Service API for heartbeat reactor lifecycle.
 */
export interface HeartbeatReactorShape {
  /**
   * Start the heartbeat reactor.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

/**
 * HeartbeatReactor - Service tag for heartbeat reactor.
 */
export class HeartbeatReactor extends ServiceMap.Service<
  HeartbeatReactor,
  HeartbeatReactorShape
>()("t3/orchestration/Services/HeartbeatReactor") {}
