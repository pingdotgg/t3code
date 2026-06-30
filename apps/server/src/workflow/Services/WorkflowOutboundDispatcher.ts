import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowOutboundDispatcherShape {
  /** Drain due `workflow_outbound_delivery` rows and POST each rendered payload.
   *
   * Per-delivery isolation: a transient/expected failure (HTTP error, dangling
   * connection, SSRF block) backs off ONLY that row; a programming defect
   * (die/interrupt) re-raises to the sweep-level guard. Never aborts the sweep.
   */
  readonly sweep: () => Effect.Effect<void>;
  /**
   * Reset rows stranded mid-claim ('processing') back to 'pending' so a future
   * sweep re-selects them. A crash after claimRow but before markSent /
   * recordFailure would otherwise leave a row 'processing' forever (sweeps only
   * select 'pending'). Run once at boot, before the sweep loop starts.
   */
  readonly recoverStaleClaims: () => Effect.Effect<void>;
  /** Fork the sweep on a fixed interval. Recovery-gating is the caller's job. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowOutboundDispatcher extends Context.Service<
  WorkflowOutboundDispatcher,
  WorkflowOutboundDispatcherShape
>()("t3/workflow/Services/WorkflowOutboundDispatcher") {}
