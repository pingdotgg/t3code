/**
 * The GitHub driver: repository operations and discovery through `gh` and git, and pull requests
 * through the GitHub REST and GraphQL APIs.
 *
 * @module source-control-github/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: "github",
  make: Effect.all({
    sourceControl: GitHubSourceControlProvider.make,
    discovery: GitHubSourceControlProvider.makeDiscovery,
    pullRequests: GitHubPullRequestProvider.make,
  }),
});
