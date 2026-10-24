import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../client/definition.ts";

import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: Effect.all({
    sourceControl: AzureDevOpsSourceControlProvider.make,
    discovery: Effect.succeed(AzureDevOpsSourceControlProvider.discovery),
    pullRequests: AzureDevOpsPullRequestProvider.make,
  }),
});
