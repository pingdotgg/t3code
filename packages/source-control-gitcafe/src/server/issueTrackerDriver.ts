import { IssueTrackerKind } from "@t3tools/contracts";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

import * as GitCafeIssueTracker from "./GitCafeIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: IssueTrackerKind.make("gitcafe"),
  make: GitCafeIssueTracker.make,
});
