import type { ServerProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateWindow from "./UpdateWindow.ts";

/** A failed install is retried for the same version only after this long. */
const RETRY_AFTER = Duration.hours(6);
const FIRST_PASS_DELAY = Duration.minutes(2);
const PASS_INTERVAL = Duration.minutes(10);

function isAutoUpdatable(provider: ServerProvider): boolean {
  const advisory = provider.versionAdvisory;
  const updateStatus = provider.updateState?.status;
  return (
    provider.enabled &&
    provider.installed &&
    advisory?.status === "behind_latest" &&
    advisory.canUpdate &&
    advisory.latestVersion !== null &&
    // The runner refuses these, which would leave a failure nobody asked for.
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
    updateStatus !== "queued" &&
    updateStatus !== "running"
  );
}

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
    // Keyed by instance and target version, so a newer release retries at once.
    const attempts = new Map<string, number>();

    const pass = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.automaticUpdates || !settings.enableProviderUpdateChecks) return;
      for (const { instanceId } of yield* providers.getProviders) {
        const install = Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          if (!settings.automaticUpdates || !settings.enableProviderUpdateChecks) return;
          const current = (yield* providers.getProviders).find(
            (candidate) => candidate.instanceId === instanceId,
          );
          if (!current || !isAutoUpdatable(current)) return;
          const targetVersion = current.versionAdvisory?.latestVersion;
          const attemptKey = `${instanceId}@${targetVersion}`;
          const nowMs = yield* Clock.currentTimeMillis;
          const attemptedAt = attempts.get(attemptKey);
          if (attemptedAt !== undefined && nowMs - attemptedAt < Duration.toMillis(RETRY_AFTER))
            return;
          attempts.set(attemptKey, nowMs);
          yield* Effect.logInfo("Updating provider in the background", {
            instanceId,
            fromVersion: current.version,
            targetVersion,
          });
          yield* runner
            .updateProvider({ provider: current.driver, instanceId, quiet: true })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Background provider update failed", { instanceId, cause }),
              ),
            );
        });
        // Rechecked per install: the previous one may have run for minutes.
        if (Option.isNone(yield* updateWindow.runIfOpen(install))) return;
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
