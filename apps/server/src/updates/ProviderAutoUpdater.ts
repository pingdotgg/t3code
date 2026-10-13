import type { ProviderInstanceId } from "@t3tools/contracts";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateWindow from "./UpdateWindow.ts";

/** An instance is tried once per release, then again only after this long. */
const RETRY_AFTER = Duration.hours(6);
const FIRST_PASS_DELAY = Duration.minutes(2);
const PASS_INTERVAL = Duration.minutes(10);

/**
 * Installs provider CLI updates in the background when `automaticUpdates` is
 * on, one instance at a time, only while the update window is open.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // A dev server shares the host's CLIs with the real install; leave them to it.
    if ((yield* ServerConfig.ServerConfig).devUrl !== undefined) return;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const updateWindow = yield* UpdateWindow.UpdateWindow;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    // `instanceId@version` to when it was last tried, on the monotonic clock.
    const attempts = new Map<string, number>();

    const enabled = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.automaticUpdates && settings.enableProviderUpdateChecks),
      Effect.orElseSucceed(() => false),
    );

    /** Chooses what to install for one instance and spends its retry budget, or returns undefined. */
    const pick = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        if (!(yield* enabled)) return undefined;
        const current = (yield* providers.getProviders).find(
          (candidate) => candidate.instanceId === instanceId,
        );
        const updateStatus = current?.updateState?.status;
        if (
          !current?.enabled ||
          !current.installed ||
          updateStatus === "queued" ||
          updateStatus === "running"
        ) {
          return undefined;
        }
        // A headless service has no client refreshing advisories, so look up the newest release here.
        const capabilities = yield* providers.getProviderMaintenanceCapabilitiesForInstance(
          instanceId,
          current.driver,
        );
        const advisory = (yield* enrichProviderSnapshotWithVersionAdvisory(current, capabilities, {
          enableProviderUpdateChecks: true,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        )).versionAdvisory;
        const targetVersion = advisory?.latestVersion;
        if (advisory?.status !== "behind_latest" || !advisory.canUpdate || !targetVersion) {
          return undefined;
        }
        const nowMs = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
        for (const [key, attemptedAt] of attempts) {
          if (nowMs - attemptedAt >= Duration.toMillis(RETRY_AFTER)) attempts.delete(key);
        }
        const attemptKey = `${instanceId}@${targetVersion}`;
        if (attempts.has(attemptKey)) return undefined;
        attempts.set(attemptKey, nowMs);
        yield* Effect.logInfo("Updating provider in the background", {
          instanceId,
          fromVersion: current.version,
          targetVersion,
        });
        return { provider: current.driver, targetVersion, attemptKey };
      });

    const pass = Effect.gen(function* () {
      if (!(yield* enabled)) return;
      for (const { instanceId } of yield* providers.getProviders) {
        // Rechecked per install: the previous one may have run for minutes.
        const picked = yield* updateWindow.runIfOpen(pick(instanceId));
        if (Option.isNone(picked)) return;
        if (picked.value === undefined) continue;
        const { provider, targetVersion, attemptKey } = picked.value;
        // Runs under the install lock, which would close the window on itself.
        const beforeInstall = Effect.gen(function* () {
          const allowed =
            (yield* enabled) && (yield* updateWindow.isOpen({ ignoreInstallLocks: true }));
          // Postponed, not failed: the next open window gets a fresh try.
          if (!allowed) attempts.delete(attemptKey);
          return allowed;
        }).pipe(Effect.catchCause(() => Effect.succeed(false)));
        yield* runner
          .updateProvider({ provider, instanceId, targetVersion, background: true, beforeInstall })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Background provider update failed", { instanceId, cause }),
            ),
          );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Provider auto-update pass failed", { cause }),
      ),
      Effect.withSpan("updates.ProviderAutoUpdater.pass"),
    );

    yield* forkParked(
      Effect.sleep(FIRST_PASS_DELAY).pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
      ),
    );
  }),
);
