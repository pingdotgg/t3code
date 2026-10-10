import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
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
    if ((yield* ServerConfig.ServerConfig).devUrl !== undefined) return;
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    if (selfUpdate.capability !== "boot-service") return;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    const updateWindow = yield* UpdateWindow.UpdateWindow;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
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
      // One staged release at a time, so a closed window cannot pile up downloads.
      if (nowMs >= nextReleaseCheckAt && pendingTarget === undefined) {
        nextReleaseCheckAt = nowMs + Duration.toMillis(RELEASE_CHECK_INTERVAL);
        const targetVersion = yield* resolveNewestVersion(cliReleaseChannelOf(currentVersion)).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        if (
          compareExactServiceVersions(targetVersion, currentVersion) > 0 &&
          !skippedTargets.has(targetVersion)
        ) {
          yield* Effect.logInfo("Staging a background server update", { targetVersion });
          // A failed download is retried at the next release check; a release
          // this launcher cannot run waits for a manual service update.
          const staged = yield* selfUpdate.stage(targetVersion).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (Predicate.isTagged(error.cause, "PinnedRuntimePreflightBlockedError")) {
                  skippedTargets.add(targetVersion);
                }
              }),
            ),
          );
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
        Effect.gen(function* () {
          // The setting may have been turned off while waiting.
          if (!(yield* automaticUpdatesEnabled)) return;
          pendingTarget = undefined;
          skippedTargets.add(targetVersion);
          yield* Effect.logInfo("Installing a background server update", { targetVersion });
          yield* selfUpdate.update({ targetVersion }).pipe(
            // Refused before the handoff (say, a manual update in progress): the
            // next hourly release check stages it again.
            Effect.tapError(() =>
              Clock.currentTimeMillis.pipe(
                Effect.map((failedAtMs) => {
                  skippedTargets.delete(targetVersion);
                  nextReleaseCheckAt = failedAtMs + Duration.toMillis(RELEASE_CHECK_INTERVAL);
                }),
              ),
            ),
          );
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
