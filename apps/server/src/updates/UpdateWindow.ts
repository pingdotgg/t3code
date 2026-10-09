import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderMaintenanceCoordinator from "../provider/providerMaintenanceCommandCoordinator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Work due this soon keeps the window closed, so it does not start late. */
const UPDATE_LOOKAHEAD = Duration.minutes(5);
/**
 * How long every client must be untouched before an update may interrupt it.
 * Clients report activity about every 25s, so this must stay well above that.
 */
const QUIET_PERIOD = Duration.minutes(15);
/**
 * Tasks repeating more often than this always have a run due soon. A run that
 * starts mid-install waits for the admission permit, and a run missed during a
 * restart catches up afterwards, so these only block while running.
 */
const FREQUENT_TASK_INTERVAL = Duration.minutes(15);

/**
 * Decides when a background update may restart the server or replace a
 * provider CLI without cutting off someone's work.
 */
export class UpdateWindow extends Context.Service<
  UpdateWindow,
  {
    /**
     * Runs `install` if the window is open, holding the admission permit that
     * provider turn starts wait for, so a CLI is never replaced as a turn starts.
     */
    readonly runIfOpen: <A, E, R>(
      install: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("t3/updates/UpdateWindow") {}

const make = Effect.fn("updates.UpdateWindow.make")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const admission = yield* ProviderMaintenanceCoordinator.ProviderMaintenanceAdmission;

  /** Returns what keeps the window closed; empty means open. */
  const blockers = Effect.fn("updates.UpdateWindow.blockers")(function* () {
    const now = yield* DateTime.now;
    const horizon = DateTime.addDuration(now, UPDATE_LOOKAHEAD);
    const found: Array<string> = [];

    // A failed read keeps the window closed: guessing "idle" could cut off a turn.
    const activeThreadIds = yield* projections.getRecoveryThreadIds("active-work").pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Update window could not read threads", { cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(activeThreadIds)) return ["active-threads"];
    if (activeThreadIds.value.length > 0) found.push("active-threads");

    // Includes installs someone started by hand.
    const providerUpdating = (yield* providers.getProviders).some(
      (provider) =>
        provider.updateState?.status === "queued" || provider.updateState?.status === "running",
    );
    if (providerUpdating) found.push("provider-update");

    const lastInteraction = yield* backgroundPolicy.lastClientInteractionAt;
    if (DateTime.isGreaterThan(DateTime.addDuration(lastInteraction, QUIET_PERIOD), now)) {
      found.push("recent-interaction");
    }

    const tasks = yield* scheduledTasks.list().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Update window could not read scheduled tasks", { cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(tasks)) return [...found, "scheduled-task"];
    for (const task of tasks.value.tasks) {
      if (task.lastRunStatus === "running") {
        found.push("scheduled-task");
        continue;
      }
      if (!task.enabled || task.nextRunAt === null) continue;
      if (
        task.schedule.type === "interval" &&
        task.schedule.everyMs < Duration.toMillis(FREQUENT_TASK_INTERVAL)
      ) {
        continue;
      }
      const runsAt = DateTime.make(task.nextRunAt);
      if (Option.isSome(runsAt) && !DateTime.isGreaterThan(runsAt.value, horizon)) {
        found.push("scheduled-task");
      }
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Update window could not read settings", { cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(settings)) return [...found, "settings"];
    const limited = yield* projections
      .getLimitRecoveryCandidates({
        now: horizon,
        autoResume: settings.value.autoResumeLimitedThreads,
        snooze: false,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Update window could not read usage-limit resumes", { cause }),
        ),
        Effect.option,
      );
    if (Option.isNone(limited)) return [...found, "usage-limit-resume"];
    for (const thread of limited.value) {
      if (thread.usageLimitResetAt === null || thread.usageLimitResetAt === undefined) continue;
      const resumesAt = DateTime.make(thread.usageLimitResetAt);
      if (Option.isSome(resumesAt) && !DateTime.isGreaterThan(resumesAt.value, horizon)) {
        found.push("usage-limit-resume");
      }
    }

    return found;
  });

  const runIfOpen: UpdateWindow["Service"]["runIfOpen"] = (install) =>
    admission.withPermit(
      blockers().pipe(
        Effect.flatMap((found) =>
          found.length === 0
            ? Effect.asSome(install)
            : Effect.logDebug("Background update waiting for the update window", {
                blockers: [...new Set(found)],
              }).pipe(Effect.as(Option.none())),
        ),
      ),
    );

  return UpdateWindow.of({ runIfOpen });
});

export const layer = Layer.effect(UpdateWindow, make());
