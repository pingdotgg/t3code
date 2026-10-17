/**
 * The Azure DevOps issue tracker driver, registered beside the source control driver so the
 * server's issue registry can list it without knowing the package.
 *
 * @module source-control-azure-devops/server/issueTrackerDriver
 */
import { IssueTrackerKind } from "@t3tools/contracts";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: IssueTrackerKind.make("azure-devops"),
  make: AzureDevOpsIssueTracker.make,
});
