import * as AzureDevOpsIssueTrackerDriver from "@t3tools/source-control-azure-devops/server/issueTrackerDriver";
import * as ForgejoIssueTrackerDriver from "@t3tools/source-control-forgejo/server/issueTrackerDriver";
import * as GitHubIssueTrackerDriver from "@t3tools/source-control-github/server/issueTrackerDriver";
import * as GitLabIssueTrackerDriver from "@t3tools/source-control-gitlab/server/issueTrackerDriver";
import type { IssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import * as LinearIssueTrackerDriver from "@t3tools/issue-tracker-linear/server/issueTrackerDriver";

import * as JiraIssueTrackerDriver from "@t3tools/issue-tracker-jira/server/issueTrackerDriver";

const drivers = [
  JiraIssueTrackerDriver.driver,
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
