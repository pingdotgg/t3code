import type { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Config from "effect/Config";
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
import * as TerminalManager from "../terminal/Manager.ts";

/** Work due this soon keeps the window closed, so it does not start late. */
const UPDATE_LOOKAHEAD = Duration.minutes(5);

/**
 * Background update pacing. `T3CODE_UPDATE_LAB=1` (scripts/update-lab.ts)
 * shortens the waits so update flows can be exercised in seconds.
 */
export const updateTimings = Config.Boolean("T3CODE_UPDATE_LAB").pipe(
  Config.withDefault(false),
  Config.map((lab) => ({
    /**
     * How long every client must be untouched before an update may interrupt
     * it. Clients report activity about every 25s, so this must stay well above that.
     */
    quietPeriod: lab ? Duration.seconds(60) : Duration.minutes(15),
    /** How often a waiting update rechecks the window or looks for new versions. */
    recheck: lab ? Duration.seconds(5) : Duration.seconds(30),
    firstPassDelay: lab ? Duration.seconds(10) : Duration.minutes(2),
    passInterval: lab ? Duration.seconds(20) : Duration.minutes(10),
    /** T3 releases are checked this often; the desktop app polls its own feed. */
    releaseCheckInterval: lab ? Duration.seconds(20) : Duration.hours(1),
  })),
);

export type UpdateWindowBlocker =
  | { readonly type: "active-threads"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly type: "recent-interaction"; readonly quietAt: DateTime.Utc }
  | { readonly type: "focused-window" }
  | { readonly type: "provider-update" }
  | { readonly type: "terminal-work" }
  | {
      readonly type: "scheduled-task";
      readonly taskId: ScheduledTaskId;
      readonly title: string;
      /** Null while the task is running. */
      readonly runsAt: DateTime.Utc | null;
    }
  | {
      readonly type: "usage-limit-resume";
      readonly threadId: ThreadId;
      readonly resumesAt: DateTime.Utc;
    };

export interface UpdateWindowOptions {
  /** The update closes the app windows (a desktop install), not just a reconnect. */
  readonly closesWindows: boolean;
  /** Server shutdown also terminates integrated terminals. */
  readonly restartsServer?: boolean;
}

export interface UpdateWindowStatus {
  readonly open: boolean;
  readonly blockers: ReadonlyArray<UpdateWindowBlocker>;
}

/**
 * Decides when a background update may restart the server, replace a provider
 * CLI, or relaunch the desktop app without cutting off someone's work.
 */
export class UpdateWindow extends Context.Service<
  UpdateWindow,
  {
    readonly check: (options: UpdateWindowOptions) => Effect.Effect<UpdateWindowStatus>;
    /**
     * Runs `install` if the window is open, holding a lock every background
     * install shares, so a server restart never cuts off a CLI install.
     */
    readonly runIfOpen: <A, E, R>(
      options: UpdateWindowOptions,
      install: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    /** Waits for the window, then runs `install` like `runIfOpen`. */
    readonly runWhenOpen: <A, E, R>(
      options: UpdateWindowOptions,
      install: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/updates/UpdateWindow") {}

const make = Effect.fn("updates.UpdateWindow.make")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const timings = yield* updateTimings;
  const admission = yield* ProviderMaintenanceCoordinator.ProviderMaintenanceAdmission;
  const terminals = yield* TerminalManager.TerminalManager;

  const check: UpdateWindow["Service"]["check"] = Effect.fn("updates.UpdateWindow.check")(
    function* (options) {
      const now = yield* DateTime.now;
      const horizon = DateTime.addDuration(now, UPDATE_LOOKAHEAD);
      const blockers: Array<UpdateWindowBlocker> = [];

      // A failed read keeps the window closed: guessing "idle" could cut off a turn.
      const activeThreadIds = yield* projections.getRecoveryThreadIds("active-work").pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Update window could not read threads", { cause }),
        ),
        Effect.option,
      );
      if (Option.isNone(activeThreadIds)) {
        return { open: false, blockers: [{ type: "active-threads", threadIds: [] }] };
      }
      if (activeThreadIds.value.length > 0) {
        blockers.push({ type: "active-threads", threadIds: activeThreadIds.value });
      }

      // Includes installs someone started by hand.
      const providerUpdating = (yield* providers.getProviders).some(
        (provider) =>
          provider.updateState?.status === "queued" || provider.updateState?.status === "running",
      );
      if (providerUpdating) {
        blockers.push({ type: "provider-update" });
      }
      if (options.restartsServer && (yield* terminals.hasBusyTerminals)) {
        blockers.push({ type: "terminal-work" });
      }

      const lastInteraction = yield* backgroundPolicy.lastClientInteractionAt;
      if (Option.isSome(lastInteraction)) {
        const quietAt = DateTime.addDuration(lastInteraction.value, timings.quietPeriod);
        if (DateTime.isGreaterThan(quietAt, now)) {
          blockers.push({ type: "recent-interaction", quietAt });
        }
      }

      if (options.closesWindows) {
        const policy = yield* backgroundPolicy.snapshot;
        const hostIdleSeconds = policy.hostPower.stale ? null : policy.hostPower.idleSeconds;
        const hostAway =
          hostIdleSeconds !== null && hostIdleSeconds >= Duration.toSeconds(timings.quietPeriod);
        const windowFocused = policy.leases.some(
          (lease) => lease.clientKind === "desktop-renderer" && lease.focused,
        );
        if (windowFocused && !hostAway) {
          blockers.push({ type: "focused-window" });
        }
      }

      const tasks = yield* scheduledTasks.list().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Update window could not read scheduled tasks", { cause }),
        ),
        Effect.option,
      );
      if (Option.isNone(tasks)) {
        return { open: false, blockers };
      }
      for (const task of tasks.value.tasks) {
        if (task.lastRunStatus === "running") {
          blockers.push({
            type: "scheduled-task",
            taskId: task.id,
            title: task.title,
            runsAt: null,
          });
          continue;
        }
        if (!task.enabled || task.nextRunAt === null) continue;
        const runsAt = DateTime.make(task.nextRunAt);
        if (Option.isSome(runsAt) && !DateTime.isGreaterThan(runsAt.value, horizon)) {
          blockers.push({
            type: "scheduled-task",
            taskId: task.id,
            title: task.title,
            runsAt: runsAt.value,
          });
        }
      }

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Update window could not read settings", { cause }),
        ),
        Effect.option,
      );
      if (Option.isNone(settings) || !settings.value.automaticUpdates) {
        return { open: false, blockers };
      }
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
      if (Option.isNone(limited)) return { open: false, blockers };
      for (const thread of limited.value) {
        if (thread.usageLimitResetAt === null || thread.usageLimitResetAt === undefined) continue;
        const resumesAt = DateTime.make(thread.usageLimitResetAt);
        if (Option.isSome(resumesAt) && !DateTime.isGreaterThan(resumesAt.value, horizon)) {
          blockers.push({
            type: "usage-limit-resume",
            threadId: thread.id,
            resumesAt: resumesAt.value,
          });
        }
      }

      return { open: blockers.length === 0, blockers };
    },
  );

  const runIfOpen: UpdateWindow["Service"]["runIfOpen"] = (options, install) => {
    const attempt = check(options).pipe(
      Effect.flatMap((status) => {
        if (!status.open) return Effect.succeedNone;
        if (!options.restartsServer) return Effect.asSome(install);
        // Keep input available during the full check, then close the terminal race before restart.
        return terminals.withRestartPermit(
          terminals.hasBusyTerminals.pipe(
            Effect.flatMap((busy) => (busy ? Effect.succeedNone : Effect.asSome(install))),
          ),
        );
      }),
    );
    return admission.withPermit(attempt);
  };
  const runWhenOpen: UpdateWindow["Service"]["runWhenOpen"] = (options, install) =>
    Effect.gen(function* () {
      while (true) {
        const result = yield* runIfOpen(options, install);
        if (Option.isSome(result)) return result.value;
        yield* Effect.sleep(timings.recheck);
      }
    });

  return UpdateWindow.of({ check, runIfOpen, runWhenOpen });
});

export const layer = Layer.effect(UpdateWindow, make()).pipe(
  Layer.provide(ProviderMaintenanceCoordinator.admissionLayer),
);
