/**
 * The issue tracker drivers this build ships with. Git hosts contribute theirs from their source
 * control package; a standalone tracker (Linear, Jira) adds its own package and a row here. A
 * kind with no driver shows up as unsupported rather than missing: Bitbucket is one, since its
 * issue tracker is retired on bitbucket.org.
 *
 * The services the git-host drivers need are the same ones `sourceControl/builtInDrivers.ts`
 * provides, so the server reuses that layer rather than building a second request policy. A
 * standalone tracker needs only the HttpClient and `IssueTrackerHost` for its stored credential.
 *
 * @module issue/builtInIssueTrackers
 */
import type { IssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import * as JiraIssueTrackerDriver from "@t3tools/issue-tracker-jira/server/issueTrackerDriver";
import * as LinearIssueTrackerDriver from "@t3tools/issue-tracker-linear/server/issueTrackerDriver";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";

const drivers = [
  ...BuiltInDrivers.BUILT_IN_GIT_HOST_ISSUE_DRIVERS,
  LinearIssueTrackerDriver.driver,
  JiraIssueTrackerDriver.driver,
];

export type BuiltInIssueTrackersEnv =
  (typeof drivers)[number] extends IssueTrackerDriver<infer R> ? R : never;

export const BUILT_IN_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerDriver<BuiltInIssueTrackersEnv>> =
  drivers;
