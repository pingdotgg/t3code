import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { resolveNewestVersion } from "../cli/update.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstallLock from "../provider/ProviderInstallLock.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateWindow from "./UpdateWindow.ts";

const FIRST_PASS_DELAY = Duration.minutes(2);
/** How often a staged update rechecks the update window. */
const WINDOW_RECHECK = Duration.minutes(1);
const RELEASE_CHECK_INTERVAL = Duration.hours(1);
/** How long a handed-off update may take to stop this server. */
const HANDOFF_TIMEOUT = Duration.minutes(5);
/** Turn starts wait for any held install lock, so holding this one closes the gate. */
const RESTART_LOCK_KEY = "server-restart";

/**
 * Updates a background-service install in the background when
 * `automaticUpdates` is on: stages the newest release on its channel right
 * away, then hands off to the launcher once the update window opens. Desktop,
 * `npx`, terminal and dev servers cannot replace themselves and are skipped.
 */
export const makeUpdatePass = () =>
  Effect.gen(function* () {
    // A dev server must not restart the service it runs beside.
    if ((yield* ServerConfig.ServerConfig).devUrl !== undefined) return { pass: Effect.void };
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    if (selfUpdate.capability !== "boot-service") return { pass: Effect.void };
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    const updateWindow = yield* UpdateWindow.UpdateWindow;
    const installLock = yield* ProviderInstallLock.ProviderInstallLock;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const currentVersion = packageJson.version;
    let staged: string | undefined;
    let nextReleaseCheckAt = 0;
    // A release the launcher rolled back would otherwise loop hourly; others are skipped per version.
    const skipped = new Set<string>();
    if (launcher.lastOutcome !== undefined && launcher.lastOutcome.status !== "committed") {
      skipped.add(launcher.lastOutcome.targetVersion);
    }

    const enabled = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.automaticUpdates),
      Effect.orElseSucceed(() => false),
    );

    const stageNewest = Effect.gen(function* () {
      nextReleaseCheckAt =
        (yield* Clock.currentTimeMillis) + Duration.toMillis(RELEASE_CHECK_INTERVAL);
      const targetVersion = yield* resolveNewestVersion(cliReleaseChannelOf(currentVersion)).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (
        compareExactServiceVersions(targetVersion, currentVersion) <= 0 ||
        skipped.has(targetVersion)
      ) {
        // A staged release the feed no longer offers must not be installed later.
        staged = undefined;
        return;
      }
      if (targetVersion === staged) return;
      yield* Effect.logInfo("Staging a background server update", { targetVersion });
      const { orchestrationProtocol } = yield* selfUpdate.stage(targetVersion);
      if (orchestrationProtocol !== ORCHESTRATION_PROTOCOL_VERSION) {
        // Connected clients would be refused after the restart.
        skipped.add(targetVersion);
        yield* Effect.logInfo("Skipping a background update with a different client protocol", {
          targetVersion,
        });
        return;
      }
      staged = targetVersion;
    });

    const handOff = (targetVersion: string) =>
      Effect.gen(function* () {
        // The setting may have been turned off while waiting for the window.
        if (!(yield* enabled)) return;
        staged = undefined;
        skipped.add(targetVersion);
        yield* Effect.logInfo("Installing a background server update", { targetVersion });
        yield* selfUpdate.update({ targetVersion }).pipe(
          // Refused before the handoff (say, a manual update in progress): stage again next check.
          Effect.tapError(() => Effect.sync(() => skipped.delete(targetVersion))),
        );
        // The launcher stops this server after accepting. Held until then, a turn
        // cannot start in the gap, but not forever if the launcher never does.
        yield* Effect.sleep(HANDOFF_TIMEOUT);
        yield* Effect.logWarning("The service launcher did not stop this server after an update", {
          targetVersion,
        });
      });

    const pass = Effect.gen(function* () {
      if (!(yield* enabled)) return;
      // Keeps checking while staged: the window may stay closed past a newer or withdrawn release.
      if ((yield* Clock.currentTimeMillis) >= nextReleaseCheckAt) {
        yield* stageNewest;
      }
      const targetVersion = staged;
      if (targetVersion === undefined) return;
      yield* updateWindow.runIfOpen(
        installLock.tryRun(RESTART_LOCK_KEY, () => handOff(targetVersion)),
        { restartsServer: true },
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Background server update failed", { cause })),
      Effect.withSpan("updates.ServerAutoUpdater.pass"),
    );

    return { pass };
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { pass } = yield* makeUpdatePass();
    yield* forkParked(
      Effect.sleep(FIRST_PASS_DELAY).pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(WINDOW_RECHECK)))),
      ),
    );
  }),
);
