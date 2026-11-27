import * as Effect from "effect/Effect";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

/**
 * The Jira Cloud tracker over its own REST client. Needs the platform HttpClient, and the
 * server's `IssueTrackerHost` for the site, email and API token saved in Settings.
 */
export const make = JiraIssueTracker.make.pipe(
  Effect.provideServiceEffect(JiraApi.JiraApi, JiraApi.make),
);
