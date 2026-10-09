import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { resolveNewestVersion } from "../cli/update.ts";
import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import {
  compareExactServiceVersions,
  SERVICE_STATE_FILE,
  serviceStateActiveVersion,
} from "../cloud/serviceProtocol.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateWindow from "./UpdateWindow.ts";

const FIRST_PASS_DELAY = Duration.minutes(2);
/** How often a staged update rechecks the update window. */
const RECHECK = Duration.seconds(30);
/** T3 releases are checked this often; the desktop app polls its own feed. */
const RELEASE_CHECK_INTERVAL = Duration.hours(1);
/** How long a handed-off install waits for the launcher to stop this server. */
const HANDOFF_TIMEOUT = Duration.minutes(5);

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
    const { baseDir, devUrl } = yield* ServerConfig.ServerConfig;
    if (devUrl !== undefined) return;
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    if (selfUpdate.capability !== "boot-service") return;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    const updateWindow = yield* UpdateWindow.UpdateWindow;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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

    /** Deletes a staged runtime nothing will run: never this version or the launcher's active one. */
    const removeStagedRuntime = Effect.fn("updates.ServerAutoUpdater.removeStagedRuntime")(
      function* (version: string) {
        if (version === currentVersion) return;
        const activeVersion = yield* fs
          .readFileString(path.join(baseDir, "runtime", SERVICE_STATE_FILE))
          .pipe(Effect.map(serviceStateActiveVersion), Effect.option);
        // Without readable launcher state, the version might be active; keep it.
        if (activeVersion._tag === "None" || activeVersion.value === undefined) return;
        if (activeVersion.value === version) return;
        yield* fs
          .remove(path.join(pinnedRuntimeVersionsDir(path, baseDir), version), {
            recursive: true,
            force: true,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove a staged server runtime", { version, cause }),
            ),
          );
      },
    );

    const updateBootService = Effect.gen(function* () {
      if (!(yield* automaticUpdatesEnabled)) return;
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs >= nextReleaseCheckAt) {
        nextReleaseCheckAt = nowMs + Duration.toMillis(RELEASE_CHECK_INTERVAL);
        const targetVersion = yield* resolveNewestVersion(cliReleaseChannelOf(currentVersion)).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        if (
          compareExactServiceVersions(targetVersion, currentVersion) > 0 &&
          !skippedTargets.has(targetVersion) &&
          targetVersion !== pendingTarget
        ) {
          // A newer release replaces the pending target only once it stages.
          yield* Effect.logInfo("Staging a background server update", { targetVersion });
          // A failed download or preflight is retried at the next release check.
          const staged = yield* selfUpdate.stage(targetVersion);
          if (staged.orchestrationProtocol !== ORCHESTRATION_PROTOCOL_VERSION) {
            // Without a matching protocol, connected clients could be refused after restart.
            skippedTargets.add(targetVersion);
            yield* Effect.logInfo(
              "Skipping a background update without a matching client protocol",
              {
                targetVersion,
              },
            );
            yield* removeStagedRuntime(targetVersion);
          } else {
            const replaced = pendingTarget;
            pendingTarget = targetVersion;
            if (replaced !== undefined) yield* removeStagedRuntime(replaced);
          }
        }
      }
      const targetVersion = pendingTarget;
      if (targetVersion === undefined) return;
      yield* updateWindow.runIfOpen(
        Effect.gen(function* () {
          // The setting may have been turned off while waiting.
          if (!(yield* automaticUpdatesEnabled)) return;
          pendingTarget = undefined;
          skippedTargets.add(targetVersion);
          yield* Effect.logInfo("Installing a background server update", { targetVersion });
          yield* selfUpdate.update({ targetVersion });
          // The launcher stops us after accepting the handoff. Keep new provider
          // starts behind the install permit until then, but not forever.
          yield* Effect.sleep(HANDOFF_TIMEOUT);
          yield* Effect.logWarning(
            "The service launcher did not stop this server after an update",
            {
              targetVersion,
            },
          );
        }),
        { restartsServer: true },
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Background server update failed", { cause })),
      Effect.withSpan("updates.ServerAutoUpdater.bootService"),
    );

    yield* forkParked(
      Effect.sleep(FIRST_PASS_DELAY).pipe(
        Effect.andThen(updateBootService.pipe(Effect.repeat(Schedule.spaced(RECHECK)))),
      ),
    );
  }),
);
