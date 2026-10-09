/**
 * The Azure DevOps driver: repository operations, discovery, and pull requests through `az`.
 *
 * @module source-control-azure-devops/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: "azure-devops",
  make: Effect.all({
    sourceControl: AzureDevOpsSourceControlProvider.make,
    discovery: Effect.succeed(AzureDevOpsSourceControlProvider.discovery),
    pullRequests: AzureDevOpsPullRequestProvider.make,
  }),
});
