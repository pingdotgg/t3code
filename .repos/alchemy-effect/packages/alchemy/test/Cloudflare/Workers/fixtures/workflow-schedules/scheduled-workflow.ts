import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Cron that will not fire during a test run (midnight UTC on 1 January).
 * Used so native Workflow schedules can be asserted out-of-band without
 * creating instances.
 */
export const YEARLY_CRON = "0 0 1 1 *";

/**
 * File-based fixture for the #1473 native Workflow schedules regression on
 * the Effect-native form. Declares `schedules` on the Workflow props so
 * `putWorkflow` carries them as resource state.
 */
export default class ScheduledWorkflow extends Cloudflare.Workflow<ScheduledWorkflow>()(
  "ScheduledWorkflow",
  { schedules: [YEARLY_CRON] },
  Effect.gen(function* () {
    return Effect.fn(function* () {
      return yield* Cloudflare.Workflows.task(
        "noop",
        Effect.succeed({ ok: true }),
      );
    });
  }),
) {}
