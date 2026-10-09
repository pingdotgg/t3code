import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { CLI_RELEASE_BASE_URL_ENV, cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { resolveNewestVersion } from "../cli/update.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateWindow from "./UpdateWindow.ts";

/**
 * Updates this environment in the background when `automaticUpdates` is on.
 *
 * - Background service installs stage the newest release on their channel,
 *   then hand off to the launcher once the update window opens.
 * - Desktop-hosted servers update when the user quits the app. One backend
 *   cannot establish that every other backend the app hosts is idle.
 * - Foreground and `npx` servers cannot replace themselves and are skipped.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // A dev server must not relaunch the desktop app or service it runs beside.
    if ((yield* ServerConfig.ServerConfig).devUrl !== undefined) return;
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    if (selfUpdate.capability !== "boot-service") return;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    const updateWindow = yield* UpdateWindow.UpdateWindow;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const timings = yield* UpdateWindow.updateTimings;
    const httpClient = yield* HttpClient.HttpClient;
    // Same mirror the staged download uses, so a mirror lists what it serves.
    const releaseBaseUrl = Option.getOrUndefined(
      yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
    );
    const currentVersion = packageJson.version;
    let pendingTarget: string | undefined;
    let nextReleaseCheckAt = 0;
    // Targets this process already gave up on; the launcher remembers rollbacks across restarts.
    const skippedTargets = new Set<string>();
    if (launcher.lastOutcome !== undefined && launcher.lastOutcome.status !== "committed") {
      skippedTargets.add(launcher.lastOutcome.targetVersion);
    }

    const automaticUpdatesEnabled = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.automaticUpdates),
      Effect.orElseSucceed(() => false),
    );

    const updateBootService = Effect.gen(function* () {
      if (!(yield* automaticUpdatesEnabled)) return;
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs >= nextReleaseCheckAt) {
        nextReleaseCheckAt = nowMs + Duration.toMillis(timings.releaseCheckInterval);
        const targetVersion = yield* resolveNewestVersion(
          cliReleaseChannelOf(currentVersion),
          releaseBaseUrl,
        ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        if (
          compareExactServiceVersions(targetVersion, currentVersion) > 0 &&
          !skippedTargets.has(targetVersion) &&
          targetVersion !== pendingTarget
        ) {
          // A newer release replaces the pending target even while the window stays closed.
          pendingTarget = undefined;
          yield* Effect.logInfo("Staging a background server update", { targetVersion });
          const staged = yield* selfUpdate
            .stage(targetVersion)
            .pipe(Effect.tapError(() => Effect.sync(() => skippedTargets.add(targetVersion))));
          if (staged.orchestrationProtocol !== ORCHESTRATION_PROTOCOL_VERSION) {
            // Without a matching protocol, connected clients could be refused after restart.
            skippedTargets.add(targetVersion);
            yield* Effect.logInfo(
              "Skipping a background update without a matching client protocol",
              {
                targetVersion,
              },
            );
          } else {
            pendingTarget = targetVersion;
          }
        }
      }
      const targetVersion = pendingTarget;
      if (targetVersion === undefined) return;
      yield* updateWindow.runIfOpen(
        { closesWindows: false, restartsServer: true },
        Effect.gen(function* () {
          // The setting may have been turned off while waiting.
          if (!(yield* automaticUpdatesEnabled)) return;
          pendingTarget = undefined;
          skippedTargets.add(targetVersion);
          yield* Effect.logInfo("Installing a background server update", { targetVersion });
          yield* selfUpdate.update({ targetVersion });
          // The launcher stops us after accepting the handoff. Keep new provider
          // starts behind the install permit until this runtime is shut down.
          return yield* Effect.never;
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Background server update failed", { cause })),
      Effect.withSpan("updates.ServerAutoUpdater.bootService"),
    );

    yield* forkParked(
      Effect.sleep(timings.firstPassDelay).pipe(
        Effect.andThen(updateBootService.pipe(Effect.repeat(Schedule.spaced(timings.recheck)))),
      ),
    );
  }),
);
