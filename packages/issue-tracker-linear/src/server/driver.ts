import * as Effect from "effect/Effect";

import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueTracker from "./LinearIssueTracker.ts";

/**
 * The Linear tracker over its own API client. Needs the platform HttpClient, and the server's
 * `IssueTrackerHost` for the API key saved in Settings.
 */
export const make = LinearIssueTracker.make.pipe(
  Effect.provideServiceEffect(LinearApi.LinearApi, LinearApi.make),
);
