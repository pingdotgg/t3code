import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";

export class PullRequestProviderRegistry extends Context.Service<
  PullRequestProviderRegistry,
  {
    readonly get: (kind: SourceControlProviderKind) => PullRequestProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/pullRequest/PullRequestProviderRegistry") {}

export function fromProviders(
  providers: ReadonlyArray<PullRequestProviderApi>,
): PullRequestProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/**
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = Effect.gen(function* () {
  const drivers = yield* Effect.forEach(BuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS, (driver) =>
    driver.make.pipe(Effect.map((instance) => instance.pullRequests)),
  );
  return fromProviders(
    drivers.filter((provider): provider is PullRequestProviderApi => provider !== null),
  );
});

export const layer = Layer.effect(PullRequestProviderRegistry, make).pipe(
  Layer.provide(BuiltInDrivers.layer),
);
