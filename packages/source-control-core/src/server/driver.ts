/**
 * SourceControlDriver — what a source control provider package hands the server.
 *
 * One driver per host kind. The server lists its drivers once and both registries (repository
 * operations and pull requests) iterate that list, so adding a host means writing its package
 * and adding its driver to the list.
 *
 * `make` yields what it needs from the environment: the `SourceControlHost` port, Effect
 * platform services, and the package's own services, which the server provides from the
 * package's layers. Its `R` channel is the full list.
 *
 * @module source-control-core/server/driver
 */
import type { SourceControlProviderKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { SourceControlProviderDiscoverySpec } from "./discovery.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

export interface SourceControlDriverInstance {
  readonly sourceControl: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
  /** Null for a host whose pull requests this build cannot read. */
  readonly pullRequests: PullRequestProviderApi | null;
}

export interface SourceControlDriver<R = never> {
  readonly kind: SourceControlProviderKind;
  readonly make: Effect.Effect<SourceControlDriverInstance, never, R>;
}

/** Declares a driver with its `R` inferred from `make`. */
export const defineSourceControlDriver = <R>(
  driver: SourceControlDriver<R>,
): SourceControlDriver<R> => driver;
