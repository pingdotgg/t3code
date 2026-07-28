import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:ListPreviewRotationShifts`.
 *
 * Preview the shifts a hypothetical rotation configuration would produce
 * before creating or updating a rotation. Takes members, a time zone,
 * and recurrence settings directly, so it is account-scoped.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListPreviewRotationShiftsHttp)`.
 * @binding
 * @section Managing On-Call Rotations
 * @example Preview a Rotation Schedule
 * ```typescript
 * const listPreviewRotationShifts =
 *   yield* AWS.SSMContacts.ListPreviewRotationShifts();
 *
 * const { RotationShifts } = yield* listPreviewRotationShifts({
 *   EndTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 *   Members: ["alice", "bob"],
 *   TimeZoneId: "America/Los_Angeles",
 *   Recurrence: {
 *     NumberOfOnCalls: 1,
 *     RecurrenceMultiplier: 1,
 *     DailySettings: [{ HourOfDay: 9, MinuteOfHour: 0 }],
 *   },
 * });
 * ```
 */
export interface ListPreviewRotationShifts extends Binding.Service<
  ListPreviewRotationShifts,
  "AWS.SSMContacts.ListPreviewRotationShifts",
  () => Effect.Effect<
    (
      request: ssm.ListPreviewRotationShiftsRequest,
    ) => Effect.Effect<
      ssm.ListPreviewRotationShiftsResult,
      ssm.ListPreviewRotationShiftsError
    >
  >
> {}
export const ListPreviewRotationShifts =
  Binding.Service<ListPreviewRotationShifts>(
    "AWS.SSMContacts.ListPreviewRotationShifts",
  );
