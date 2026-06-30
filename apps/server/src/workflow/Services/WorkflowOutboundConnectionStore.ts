import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { OutboundConnectionKind, OutboundConnectionView } from "@t3tools/contracts";

export class OutboundConfigError extends Data.TaggedError("OutboundConfigError")<{
  readonly reason: string;
}> {}

export interface OutboundTarget {
  readonly kind: OutboundConnectionKind;
  readonly url: string;
}

export interface WorkflowOutboundConnectionStoreShape {
  /** Create a new outbound connection, storing the URL in the secret store.
   *
   * Fails with OutboundConfigError if the URL is SSRF-blocked, malformed,
   * not https://, or if the DB insert / secret write fails.
   */
  readonly create: (input: {
    readonly kind: OutboundConnectionKind;
    readonly displayName: string;
    readonly url: string;
  }) => Effect.Effect<OutboundConnectionView, OutboundConfigError>;

  /** List all connections (no URL in the view). */
  readonly list: () => Effect.Effect<ReadonlyArray<OutboundConnectionView>, OutboundConfigError>;

  /** Remove a connection and best-effort delete its stored secret.
   *
   * Does NOT check for boards still referencing this connectionRef — a
   * dangling ref will surface as an OutboundConfigError at delivery time.
   */
  readonly remove: (connectionRef: string) => Effect.Effect<void, OutboundConfigError>;

  /** Retrieve the delivery target (kind + url) for an existing connection.
   *
   * Fails with OutboundConfigError when no row matches the connectionRef
   * or when the stored secret is missing.
   */
  readonly getTarget: (connectionRef: string) => Effect.Effect<OutboundTarget, OutboundConfigError>;
}

export class WorkflowOutboundConnectionStore extends Context.Service<
  WorkflowOutboundConnectionStore,
  WorkflowOutboundConnectionStoreShape
>()("t3/workflow/Services/WorkflowOutboundConnectionStore") {}
