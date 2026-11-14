import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import { definition } from "../shared/definition.ts";
import * as CodeCommitSourceControlProvider from "./CodeCommitSourceControlProvider.ts";
import * as CodeCommitPullRequestProvider from "./CodeCommitPullRequestProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: Effect.all({
    sourceControl: CodeCommitSourceControlProvider.make,
    discovery: CodeCommitSourceControlProvider.makeDiscovery,
    pullRequests: CodeCommitPullRequestProvider.make,
  }),
});
