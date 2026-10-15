/**
 * The issue tracker drivers this build ships with. Git hosts contribute theirs from their source
 * control package; a standalone tracker (Linear, Jira) adds its own package and a row here. A
 * kind with no driver shows up as unsupported rather than missing.
 *
 * The services these drivers need are the same ones `sourceControl/builtInDrivers.ts` provides,
 * so the server reuses that layer rather than building a second `GitHubApi`.
 *
 * @module issue/builtInIssueTrackers
 */
import * as GitHubIssueTrackerDriver from "@t3tools/source-control-github/server/issueTrackerDriver";
import type { IssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

const drivers = [GitHubIssueTrackerDriver.driver];

export type BuiltInIssueTrackersEnv =
  (typeof drivers)[number] extends IssueTrackerDriver<infer R> ? R : never;

export const BUILT_IN_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerDriver<BuiltInIssueTrackersEnv>> =
  drivers;
