import type { SourceControlCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";

import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";

export function makeSourceControlCapability(input: {
  readonly registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
  readonly github: GitHubCli.GitHubCli["Service"];
}): SourceControlCapability {
  return {
    detectProvider: ({ cwd }) =>
      input.registry.resolveHandle({ cwd }).pipe(
        Effect.map((handle) => ({
          provider: handle.context?.provider ?? null,
          remoteName: handle.context?.remoteName ?? null,
          remoteUrl: handle.context?.remoteUrl ?? null,
        })),
      ),
    discoverProviders: input.registry.discover,
    listOpenPullRequests: (request) => input.github.listOpenPullRequests(request),
    getPullRequest: (request) => input.github.getPullRequest(request),
    createPullRequest: (request) => input.github.createPullRequest(request),
    getDefaultBranch: (request) => input.github.getDefaultBranch(request),
    checkoutPullRequest: (request) => input.github.checkoutPullRequest(request),
  };
}
