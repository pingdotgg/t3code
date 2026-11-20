import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { resolveMirrorVersion, resolveNewestVersion } from "../cli/update.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateMirror } from "../policy/managedUpdates.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSelfUpdate } from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { compareExactServiceVersions } from "./serviceProtocol.ts";

const AUTO_UPDATE_ENV = "T3CODE_AUTO_UPDATE";

/** The release to move to, if any. A release whose trial already failed here is not retried. */
export function autoUpdateTarget(input: {
  readonly current: string;
  readonly newest: string;
  readonly lastOutcome: ServerSelfUpdateOutcome | undefined;
}): string | undefined {
  if (compareExactServiceVersions(input.newest, input.current) <= 0) return undefined;
  const last = input.lastOutcome;
  if (last !== undefined && last.status !== "committed" && last.targetVersion === input.newest) {
    return undefined;
  }
  return input.newest;
}

// A restart would cut short a run that still owns its provider turn or a queued one about to
// start. A held queue waits on the user and would block updates indefinitely.
const runActive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly active: number }>`
    SELECT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs
      WHERE status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
    ) AS active
  `;
  return row?.active === 1;
});

/** One scheduled check. It never fails, so a failed download or lookup leaves the schedule running. */
export const autoUpdateCheck = Effect.fn("cloud.auto_update.check")(
  function* <E, R>(input: {
    readonly newest: Effect.Effect<string, E, R>;
    readonly lastOutcome: ServerSelfUpdateOutcome | undefined;
  }) {
    if (yield* runActive) return;
    const targetVersion = autoUpdateTarget({
      current: packageJson.version,
      newest: yield* input.newest,
      lastOutcome: input.lastOutcome,
    });
    if (targetVersion === undefined) return;
    const selfUpdate = yield* ServerSelfUpdate;
    // A run can start while the release downloads; activation reuses the staged runtime.
    yield* selfUpdate.update({ targetVersion, stageOnly: true });
    if (yield* runActive) return;
    yield* Effect.logInfo("Updating to the newest published release.", { targetVersion });
    yield* selfUpdate.update({ targetVersion });
  },
  Effect.catchCause((cause) => Effect.logWarning("Automatic update check failed.", { cause })),
);

/**
 * Opt-in for the background service: moves to the newest published release on this build's channel
 * through the same self-update a client starts, so the launcher's trial commits or rolls it back.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* Config.Boolean(AUTO_UPDATE_ENV).pipe(Config.withDefault(false)))) return;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    const channel = cliReleaseChannelOf(packageJson.version);
    if (!launcher.managed || channel === "preview") {
      yield* Effect.logWarning(
        `${AUTO_UPDATE_ENV} is set but only a stable or nightly background service updates itself.`,
      );
      return;
    }
    const mirror = managedUpdateMirror((yield* ManagedPolicy.ManagedPolicy).document);
    const check = autoUpdateCheck({
      newest:
        mirror === undefined
          ? resolveNewestVersion(channel)
          : resolveMirrorVersion(mirror, channel),
      lastOutcome: launcher.lastOutcome,
    });

    // ponytail: fixed hourly check; add a setting if operators need another cadence.
    yield* forkParked(
      check.pipe(Effect.delay("5 minutes"), Effect.repeat(Schedule.spaced("1 hour"))),
    );
  }),
);
