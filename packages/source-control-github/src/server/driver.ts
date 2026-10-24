import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../client/definition.ts";

import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: Effect.all({
    sourceControl: GitHubSourceControlProvider.make,
    discovery: GitHubSourceControlProvider.makeDiscovery,
    pullRequests: GitHubPullRequestProvider.make,
  }),
});
