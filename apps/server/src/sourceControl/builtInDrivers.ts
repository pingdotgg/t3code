import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@lathe/source-control-core/server/driver";
import * as SourceControlRateLimit from "@lathe/source-control-core/server/SourceControlRateLimit";
import * as FeatureFlags from "@lathe/shared/FeatureFlags";
// Fork: roadmap.
import * as GitHubIssueApi from "@lathe/source-control-github/server/GitHubIssueApi";
import * as GitHubRest from "@lathe/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("lathe/sourceControl/builtInDrivers/SourceControlDrivers") {}

/** Drivers offered only while their feature flag is on. */
const FLAGGED_DRIVERS: Readonly<Record<string, "tanstackSource">> = {
  "tanstack-source": "tanstackSource",
};

const make = Effect.gen(function* () {
  const flags = yield* FeatureFlags.FeatureFlags;
  const drivers = BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.filter((driver) => {
    const flag = FLAGGED_DRIVERS[driver.kind];
    return flag === undefined || flags[flag];
  });
  return yield* Effect.forEach(drivers, (driver) =>
    driver.make.pipe(Effect.map((instance) => ({ driver, instance }))),
  );
});

export const layer = Layer.merge(
  Layer.effect(SourceControlDrivers, make),
  // Fork: roadmap. The GitHub driver keeps its request stack private, so issue reads build their
  // own. They still share the server's rate-limit pause, but keep a separate quota reserve.
  GitHubIssueApi.layer.pipe(Layer.provide(GitHubRest.layerWithDependencies)),
).pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
