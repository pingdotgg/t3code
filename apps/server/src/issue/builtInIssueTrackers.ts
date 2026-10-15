/**
 * The issue tracker drivers this build ships with. Git hosts contribute theirs from their source
 * control package; a standalone tracker (Linear, Jira) adds its own package and a row here. A
 * kind with no driver shows up as unsupported rather than missing: Bitbucket is one, since its
 * issue tracker is retired on bitbucket.org.
 *
 * The services the git-host drivers need are the same ones `sourceControl/builtInDrivers.ts`
 * provides, so the server reuses that layer rather than building a second `GitHubApi`. A
 * standalone tracker needs only the HttpClient and `IssueTrackerHost` for its stored credential.
 *
 * @module issue/builtInIssueTrackers
 */
import * as AzureDevOpsIssueTrackerDriver from "@t3tools/source-control-azure-devops/server/issueTrackerDriver";
import * as ForgejoIssueTrackerDriver from "@t3tools/source-control-forgejo/server/issueTrackerDriver";
import * as GitHubIssueTrackerDriver from "@t3tools/source-control-github/server/issueTrackerDriver";
import * as GitLabIssueTrackerDriver from "@t3tools/source-control-gitlab/server/issueTrackerDriver";
import type { IssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import * as LinearIssueTrackerDriver from "@t3tools/issue-tracker-linear/server/issueTrackerDriver";

const drivers = [
  GitHubIssueTrackerDriver.driver,
  GitLabIssueTrackerDriver.driver,
  AzureDevOpsIssueTrackerDriver.driver,
  ForgejoIssueTrackerDriver.driver,
  LinearIssueTrackerDriver.driver,
];

export type BuiltInIssueTrackersEnv =
  (typeof drivers)[number] extends IssueTrackerDriver<infer R> ? R : never;

export const BUILT_IN_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerDriver<BuiltInIssueTrackersEnv>> =
  drivers;
