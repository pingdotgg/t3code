/**
 * The Forgejo issue tracker driver, registered beside the source control driver so the server's
 * issue registry can list it without knowing the package.
 *
 * @module source-control-forgejo/server/issueTrackerDriver
 */
import { IssueTrackerKind } from "@t3tools/contracts";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: IssueTrackerKind.make("forgejo"),
  make: ForgejoIssueTracker.make,
});
