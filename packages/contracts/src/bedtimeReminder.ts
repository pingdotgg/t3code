import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BedtimeReminderTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
export type BedtimeReminderTimeOfDay = typeof BedtimeReminderTimeOfDay.Type;

/**
 * What the server reports on `bedtimeReminder.subscribe`:
 * - `off`: no bedtime is set.
 * - `scheduled`: quiet until `nextFireAt`.
 * - `reminding`: past bedtime and not yet morning; clients show the reminder.
 */
export const BedtimeReminderState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off") }),
  Schema.Struct({
    kind: Schema.Literal("scheduled"),
    nextFireAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("reminding"),
    nightStartedAt: Schema.String,
  }),
]);
export type BedtimeReminderState = typeof BedtimeReminderState.Type;
