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

function isAutoUpdatable(provider: ServerProvider): boolean {
  const advisory = provider.versionAdvisory;
  const updateStatus = provider.updateState?.status;
  return (
    provider.enabled &&
    provider.installed &&
    advisory?.status === "behind_latest" &&
    advisory.canUpdate &&
    advisory.latestVersion !== null &&
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
    const timings = yield* UpdateWindow.updateTimings;
    // Keyed by instance and target version, so a newer release retries at once.
    const attempts = new Map<string, number>();

    const pass = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.automaticUpdates || !settings.enableProviderUpdateChecks) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const candidates = (yield* providers.getProviders).filter((provider) => {
        if (!isAutoUpdatable(provider)) return false;
        const attemptedAt = attempts.get(
          `${provider.instanceId}@${provider.versionAdvisory?.latestVersion}`,
        );
        return attemptedAt === undefined || nowMs - attemptedAt >= Duration.toMillis(RETRY_AFTER);
      });
      for (const provider of candidates) {
        const targetVersion = provider.versionAdvisory?.latestVersion;
        const install = Effect.gen(function* () {
          attempts.set(`${provider.instanceId}@${targetVersion}`, yield* Clock.currentTimeMillis);
          yield* Effect.logInfo("Updating provider in the background", {
            instanceId: provider.instanceId,
            fromVersion: provider.version,
            targetVersion,
          });
          yield* runner
            .updateProvider({ provider: provider.driver, instanceId: provider.instanceId })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Background provider update failed", {
                  instanceId: provider.instanceId,
                  cause,
                }),
              ),
            );
        });
        // Rechecked per install: the previous one may have run for minutes.
        const installed = yield* updateWindow.runIfOpen({ closesWindows: false }, install);
        if (Option.isNone(installed)) {
          yield* Effect.logDebug("Provider auto-update waiting for the update window");
          return;
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Provider auto-update pass failed", { cause }),
      ),
      Effect.withSpan("updates.ProviderAutoUpdater.pass"),
    );

    yield* forkParked(
      Effect.sleep(timings.firstPassDelay).pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(timings.passInterval)))),
      ),
    );
  }),
);
