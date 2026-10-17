/**
 * The Linear issue tracker driver. Yields the Linear API, which in turn needs the platform
 * HttpClient and the server's `IssueTrackerHost` for the stored credential.
 *
 * @module issue-tracker-linear/server/issueTrackerDriver
 */
import * as Effect from "effect/Effect";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueTracker from "./LinearIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: LinearApi.KIND,
  make: LinearIssueTracker.make.pipe(
    Effect.provideServiceEffect(LinearApi.LinearApi, LinearApi.make),
  ),
});
