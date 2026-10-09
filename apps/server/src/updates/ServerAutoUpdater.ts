import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { CLI_RELEASE_BASE_URL_ENV, cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { resolveNewestVersion } from "../cli/update.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateWindow from "./UpdateWindow.ts";

/**
 * Updates this environment in the background when `automaticUpdates` is on.
 *
 * - Background service installs stage the newest release on their channel,
 *   then hand off to the launcher once the update window opens.
 * - Desktop-hosted servers wait for the app to finish its background
 *   download, then relaunch it through the existing prepare/commit handoff
 *   once no window is in use.
 * - Foreground and `npx` servers cannot replace themselves and are skipped.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // A dev server must not relaunch the desktop app or service it runs beside.
    if ((yield* ServerConfig.ServerConfig).devUrl !== undefined) return;
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const updateWindow = yield* UpdateWindow.UpdateWindow;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const timings = yield* UpdateWindow.updateTimings;
    const httpClient = yield* HttpClient.HttpClient;
    // Same mirror the staged download uses, so a mirror lists what it serves.
    const releaseBaseUrl = Option.getOrUndefined(
      yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
    );
    const currentVersion = packageJson.version;
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
      const targetVersion = yield* resolveNewestVersion(
        cliReleaseChannelOf(currentVersion),
        releaseBaseUrl,
      ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (
        compareExactServiceVersions(targetVersion, currentVersion) <= 0 ||
        skippedTargets.has(targetVersion)
      ) {
        return;
      }
      yield* Effect.logInfo("Staging a background server update", { targetVersion });
      const staged = yield* selfUpdate.stage(targetVersion);
      if (
        staged.orchestrationProtocol !== undefined &&
        staged.orchestrationProtocol !== ORCHESTRATION_PROTOCOL_VERSION
      ) {
        // Connected clients would be refused until they update; leave this one to a person.
        skippedTargets.add(targetVersion);
        yield* Effect.logInfo("Skipping a background update that changes the client protocol", {
          targetVersion,
        });
        return;
      }
      yield* updateWindow.runWhenOpen(
        { closesWindows: false },
        Effect.gen(function* () {
          // The setting may have been turned off while waiting.
          if (!(yield* automaticUpdatesEnabled)) return;
          skippedTargets.add(targetVersion);
          yield* Effect.logInfo("Installing a background server update", { targetVersion });
          yield* selfUpdate.update({ targetVersion });
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Background server update failed", { cause })),
      Effect.withSpan("updates.ServerAutoUpdater.bootService"),
    );

    const updateDesktopApp = (downloadedVersion: string) =>
      Effect.gen(function* () {
        if (!(yield* automaticUpdatesEnabled) || skippedTargets.has(downloadedVersion)) return;
        yield* updateWindow.runWhenOpen(
          { closesWindows: true },
          Effect.gen(function* () {
            if (!(yield* automaticUpdatesEnabled)) return;
            skippedTargets.add(downloadedVersion);
            yield* Effect.logInfo("Relaunching the desktop app into a downloaded update", {
              downloadedVersion,
            });
            // The download is already on disk, so preparing it is quick.
            const prepared = yield* selfUpdate.update({ targetVersion: downloadedVersion });
            if (prepared.desktopUpdateToken === undefined) return;
            return yield* selfUpdate.commitDesktopUpdate(prepared.desktopUpdateToken);
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Background desktop update failed", { cause }),
        ),
        Effect.withSpan("updates.ServerAutoUpdater.desktopApp"),
      );

    if (selfUpdate.capability === "boot-service") {
      yield* forkParked(
        Effect.sleep(timings.firstPassDelay).pipe(
          Effect.andThen(
            updateBootService.pipe(Effect.repeat(Schedule.spaced(timings.releaseCheckInterval))),
          ),
        ),
      );
    }

    if (selfUpdate.capability === "desktop-managed") {
      // The desktop app reports its updater state on attach and on every change.
      yield* forkParked(
        Effect.scoped(
          Effect.gen(function* () {
            const { latest, changes } = yield* receiver.desktopUpdates;
            const reports = Option.match(latest, {
              onNone: () => changes,
              onSome: (report) => Stream.concat(Stream.make(report), changes),
            });
            yield* reports.pipe(
              Stream.map((report) =>
                report.state.status === "downloaded" ? report.state.downloadedVersion : null,
              ),
              Stream.filter((version): version is string => version !== null),
              Stream.changes,
              // A newer download replaces a wait for an older one.
              Stream.switchMap((version) => Stream.fromEffect(updateDesktopApp(version))),
              Stream.runDrain,
            );
          }),
        ),
      );
    }
  }),
);
