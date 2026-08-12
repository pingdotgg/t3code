import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PullRequestProviderKind } from "@t3tools/contracts";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";

export class PullRequestProviderRegistry extends Context.Service<
  PullRequestProviderRegistry,
  {
    /** Null for a host with no implementation, which the service reports as unsupported. */
    readonly get: (kind: PullRequestProviderKind) => PullRequestProviderApi | null;
    readonly kinds: ReadonlyArray<PullRequestProviderKind>;
  }
>()("t3/pullRequest/PullRequestProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
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
 * The only pull-request host this build supports.
 */
export const make = Effect.map(GitHubPullRequestProvider.make, (provider) =>
  fromProviders([provider]),
);

export const layer = Layer.effect(PullRequestProviderRegistry, make).pipe(
  Layer.provide(GitHubPullRequestCli.layer),
);
