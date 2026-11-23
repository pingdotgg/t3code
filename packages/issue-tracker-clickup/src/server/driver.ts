import * as Effect from "effect/Effect";

import * as ClickUpApi from "./ClickUpApi.ts";
import * as ClickUpIssueTracker from "./ClickUpIssueTracker.ts";

/**
 * The ClickUp tracker over its own API client. Needs the platform HttpClient, and the server's
 * `IssueTrackerHost` for the API token saved in Settings.
 */
export const make = ClickUpIssueTracker.make.pipe(
  Effect.provideServiceEffect(ClickUpApi.ClickUpApi, ClickUpApi.make),
);
