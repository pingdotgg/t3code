import { LinearError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** No API key is stored, so no request was attempted. */
export class NotConnected extends Schema.TaggedError<NotConnected>()(
  "IssueTrackerNotConnected",
  {},
) {}

/** The tracker rejected the credentials (HTTP 401 or an authentication GraphQL error). */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "IssueTrackerUnauthorized",
  {},
) {}

/** The tracker is throttling this client; retry no sooner than `retryAfterSeconds`. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("IssueTrackerRateLimited", {
  retryAfterSeconds: Schema.Number,
}) {}

/** Network failure, 5xx, or a response the client cannot decode. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("IssueTrackerUnavailable", {
  message: Schema.String,
}) {}

/** The tracker refused this request (permissions, invalid input, query complexity); not an outage. */
export class Rejected extends Schema.TaggedError<Rejected>()("IssueTrackerRejected", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("IssueTrackerNotFound", {
  message: Schema.String,
}) {}

export type IssueTrackerError =
  | NotConnected
  | Unauthorized
  | RateLimited
  | Unavailable
  | Rejected
  | NotFound;

/** The wire error clients receive. Messages are fixed text; nothing from a request reaches them. */
export function toLinearError(error: IssueTrackerError): LinearError {
  switch (error._tag) {
    case "IssueTrackerNotConnected":
      return new LinearError({ reason: "not_connected", message: "Linear is not connected." });
    case "IssueTrackerUnauthorized":
      return new LinearError({
        reason: "unauthorized",
        message: "Your Linear API key is no longer valid. Paste a new key.",
      });
    case "IssueTrackerRateLimited":
      return new LinearError({
        reason: "rate_limited",
        message: "Linear rate limit hit.",
        retryAfterSeconds: Math.max(0, Math.ceil(error.retryAfterSeconds)),
      });
    case "IssueTrackerUnavailable":
      return new LinearError({ reason: "unavailable", message: error.message });
    case "IssueTrackerRejected":
      return new LinearError({ reason: "invalid_input", message: error.message });
    case "IssueTrackerNotFound":
      return new LinearError({ reason: "not_found", message: error.message });
  }
}
