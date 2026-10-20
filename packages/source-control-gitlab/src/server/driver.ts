import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("gitlab"),
  make: Effect.all({
    sourceControl: GitLabSourceControlProvider.make,
    discovery: GitLabSourceControlProvider.makeDiscovery,
    pullRequests: GitLabPullRequestProvider.make,
  }),
});
