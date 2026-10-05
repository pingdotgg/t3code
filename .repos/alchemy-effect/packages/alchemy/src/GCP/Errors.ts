import * as Data from "effect/Data";

/**
 * Server-side failures worth another attempt: throttling and the 5xx
 * statuses Google fronts return for load, rollout, and replica hiccups.
 * Every distilled GCP operation carries these tags in its error union.
 *
 * NOT exported from `index.ts`.
 */
const TRANSIENT_TAGS = new Set([
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
]);

export const isTransientGcpError = (error: { readonly _tag: string }) =>
  TRANSIENT_TAGS.has(error._tag);

/**
 * A delete call succeeded but the resource was still readable after the
 * bounded wait-until-gone poll.
 */
export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.DeleteNotConfirmed",
)<{
  resource: string;
}> {}
