/**
 * IssueTrackerDriver — what an issue tracker package hands the server.
 *
 * One driver per tracker kind. The server lists its drivers once and the registry iterates that
 * list, so adding a tracker means writing its package and adding its driver to the list. Git
 * hosts ship their driver inside their source control package; a standalone tracker (Linear,
 * Jira) ships its own.
 *
 * `make` yields what it needs from the environment, and its `R` channel is the full list the
 * server must provide.
 *
 * @module issue-tracker-core/server/driver
 */
import type { IssueTrackerKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { IssueTrackerApi } from "./IssueTracker.ts";

export interface IssueTrackerDriver<R = never> {
  readonly kind: IssueTrackerKind;
  readonly make: Effect.Effect<IssueTrackerApi, never, R>;
}

/** Declares a driver with its `R` inferred from `make`. */
export const defineIssueTrackerDriver = <R>(driver: IssueTrackerDriver<R>): IssueTrackerDriver<R> =>
  driver;
