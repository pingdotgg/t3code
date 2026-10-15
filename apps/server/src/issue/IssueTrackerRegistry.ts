import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueTrackerKind } from "@t3tools/contracts";
import {
  isStandaloneIssueTracker,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as BuiltInIssueTrackers from "./builtInIssueTrackers.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";

export class IssueTrackerRegistry extends Context.Service<
  IssueTrackerRegistry,
  {
    /** Null for a kind with no implementation, which the service reports as unsupported. */
    readonly get: (kind: IssueTrackerKind) => IssueTrackerApi | null;
    readonly kinds: ReadonlyArray<IssueTrackerKind>;
    /** The trackers a user connects with a credential of their own, in registration order. */
    readonly standalone: ReadonlyArray<StandaloneIssueTrackerApi>;
  }
>()("t3/issue/IssueTrackerRegistry") {}

/** Exported for tests, which stand a registry up from trackers they supply themselves. */
export function fromTrackers(
  trackers: ReadonlyArray<IssueTrackerApi>,
): IssueTrackerRegistry["Service"] {
  const byKind = new Map(trackers.map((tracker) => [tracker.kind, tracker]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: trackers.map((tracker) => tracker.kind),
    standalone: trackers.filter(isStandaloneIssueTracker),
  };
}

const make = Effect.gen(function* () {
  const trackers = yield* Effect.forEach(
    BuiltInIssueTrackers.BUILT_IN_ISSUE_TRACKERS,
    (driver) => driver.make,
  );
  return fromTrackers(trackers);
});

export const layer = Layer.effect(IssueTrackerRegistry, make).pipe(
  Layer.provide(Layer.merge(BuiltInDrivers.layer, IssueTrackerHostLive.layer)),
);
