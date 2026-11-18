import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
import { skippedV2Migrations } from "../persistence/Migrations.ts";
import { reconciledV2PreviewHistory } from "../persistence/reconcileV2PreviewMigration.ts";
import type * as ProcessRunner from "../processRunner.ts";
import {
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  type PinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  isSupportedLauncherProtocol,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type SupportedLauncherProtocol,
} from "./serviceProtocol.ts";

// A staged runtime's cold start can take over a minute on a loaded, swapping host.
const PREFLIGHT_TIMEOUT = Duration.minutes(3);
const decodePreflightJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      /** The launcher protocol the server named; it accepts no other in reply. */
      readonly launcherProtocol: SupportedLauncherProtocol;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

/** The first release whose launcher gives a trial 30 minutes, not 2, to finish migrations. */
const LONG_TRIAL_LAUNCHER_VERSION = "0.0.46-nightly.20261014.3105";

// Every 0.0.46 preview predates the 30-minute deadline but sorts after "nightly".
const cutsTrialsShort = (launcherVersion: string) =>
  isExactServiceVersion(launcherVersion) &&
  (launcherVersion.startsWith("0.0.46-preview.") ||
    compareExactServiceVersions(launcherVersion, LONG_TRIAL_LAUNCHER_VERSION) < 0);

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  /** The runtime the installed unit starts its launcher from, when known. */
  readonly launcherVersion?: string | undefined;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  const { launcherProtocol } = input;
  if (!isSupportedLauncherProtocol(launcherProtocol)) {
    return {
      status: "blocked",
      version,
      // A stale `t3` earlier on PATH (an old npm/nvm global) makes `t3 service install`
      // reinstall itself and report success, so name the exact install and the path check.
      reason: [
        `The installed service launcher speaks protocol ${launcherProtocol}, but t3@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${version} sh\`.`,
        `Check that \`t3 --version\` prints ${version} and that \`which -a t3\` lists no older t3 (such as an npm or nvm install) first, then run \`~/.local/bin/t3 service install\` (the installer's default path).`,
        "Updating the desktop app does not update this CLI, and `t3 service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  // A remote update never replaces the launcher, and these roll back any trial that is
  // still migrating after 2 minutes, so a large database would roll back on every retry.
  if (
    launcherProtocol === 3 &&
    input.launcherVersion !== undefined &&
    cutsTrialsShort(input.launcherVersion)
  ) {
    return {
      status: "blocked",
      version,
      reason: [
        `The background service still runs the t3@${input.launcherVersion} launcher, which rolls back an update whose database migrations take over 2 minutes.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${version} sh\`, then run \`~/.local/bin/t3 service install\` to replace the launcher.`,
      ].join(" "),
    };
  }

  const recorded = recordedMigrations(input.databasePath);
  if (recorded === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm t3@${version} supports it.`,
    };
  }
  const newer = recorded
    .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
    .map(({ id, name }) => `${id}_${name}`);
  if (newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that t3@${version} does not know: ${newer.join(", ")}. A newer build wrote them, and running t3@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
    };
  }

  // Startup reconciles V2 preview ids before it checks the history, so check what it will see.
  const reconciled = reconciledV2PreviewHistory(recorded);
  const incompatible =
    reconciled === null ? ["an unexpected V2 preview history"] : skippedV2Migrations(reconciled);
  if (incompatible.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has incompatible migration history: ${incompatible.join(", ")}. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
    };
  }

  return { status: "ready", version, launcherProtocol };
}

function decodeServicePreflightResult(
  value: unknown,
  launcherProtocol: SupportedLauncherProtocol,
): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === launcherProtocol &&
    typeof record.version === "string"
  ) {
    return { status: "ready", version: record.version, launcherProtocol };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}

/** Asks a staged runtime whether it can run on this database under this launcher protocol. */
export const runStagedServicePreflight = Effect.fn("cloud.service_preflight.run_staged")(
  function* (input: {
    readonly runner: ProcessRunner.ProcessRunner["Service"];
    readonly runtime: PinnedRuntimePaths;
    readonly targetVersion: string;
    readonly databasePath: string;
    readonly launcherProtocol: SupportedLauncherProtocol;
    /** A local switch installs the target's own launcher, so the running one does not matter. */
    readonly replacesLauncher?: boolean;
  }) {
    const step = "running the staged service preflight";
    const command = pinnedRuntimeCommand(input.runtime);
    const result = yield* input.runner
      .run({
        command: command.command,
        args: [
          ...command.args,
          "__service-preflight",
          "--database-path",
          input.databasePath,
          "--launcher-protocol",
          String(input.launcherProtocol),
        ],
        timeout: PREFLIGHT_TIMEOUT,
        // A CLI run from a T3 terminal inherits the service's launcher context.
        ...(input.replacesLauncher === true ? { env: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "" } } : {}),
      })
      .pipe(Effect.mapError((cause) => new PinnedRuntimeInstallError({ step, cause })));
    if (result.code !== 0) {
      return yield* new PinnedRuntimeInstallError({
        step,
        exitCode: Number(result.code),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    }
    const parsed = yield* decodePreflightJson(result.stdout.trim()).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({ step: "decoding the staged service preflight", cause }),
      ),
    );
    const preflight = decodeServicePreflightResult(parsed, input.launcherProtocol);
    if (preflight === undefined || preflight.version !== input.targetVersion) {
      return yield* new PinnedRuntimeInstallError({
        step: "verifying the staged service preflight",
      });
    }
    if (preflight.status === "blocked") {
      return yield* new PinnedRuntimePreflightBlockedError({
        version: input.targetVersion,
        reason: preflight.reason,
      });
    }
  },
);
