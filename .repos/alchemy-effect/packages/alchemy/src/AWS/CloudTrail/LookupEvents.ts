import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudtrail:LookupEvents`.
 *
 * An account-level operation (no resource argument) that searches the last
 * 90 days of management events recorded in the region — the classic "who did
 * what" audit read, available without any trail or event data store. Provide
 * the implementation with `Effect.provide(AWS.CloudTrail.LookupEventsHttp)`.
 * @binding
 * @section Reading Event History
 * @example Look Up Recent Events
 * ```typescript
 * // init — account-level binding takes no resource
 * const lookupEvents = yield* AWS.CloudTrail.LookupEvents();
 *
 * // runtime
 * const result = yield* lookupEvents({
 *   LookupAttributes: [
 *     { AttributeKey: "EventName", AttributeValue: "CreateBucket" },
 *   ],
 *   MaxResults: 10,
 * });
 * console.log(result.Events?.map((e) => e.EventName));
 * ```
 */
export interface LookupEvents extends Binding.Service<
  LookupEvents,
  "AWS.CloudTrail.LookupEvents",
  () => Effect.Effect<
    (
      request?: cloudtrail.LookupEventsRequest,
    ) => Effect.Effect<
      cloudtrail.LookupEventsResponse,
      cloudtrail.LookupEventsError
    >
  >
> {}
export const LookupEvents = Binding.Service<LookupEvents>(
  "AWS.CloudTrail.LookupEvents",
);
