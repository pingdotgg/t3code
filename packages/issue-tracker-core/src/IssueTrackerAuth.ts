import * as Effect from "effect/Effect";

import { NotConnected } from "./errors.ts";

/**
 * The seam between a tracker client and how it authenticates. Today only personal API keys exist;
 * OAuth would add another constructor that returns `Bearer <token>` without touching clients.
 */
export interface IssueTrackerAuth {
  /** Value of the `Authorization` header, resolved per request so key changes apply immediately. */
  readonly authorizationHeader: Effect.Effect<string, NotConnected>;
}

/** Linear personal API keys go in the header as-is, without a `Bearer` prefix. */
export const apiKeyAuth = (readApiKey: Effect.Effect<string>): IssueTrackerAuth => ({
  authorizationHeader: readApiKey.pipe(
    Effect.filterOrFail(
      (key) => key.length > 0,
      () => new NotConnected(),
    ),
  ),
});
