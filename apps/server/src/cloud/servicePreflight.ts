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
  isSupportedLauncherProtocol,
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

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  const { launcherProtocol } = input;
  if (!isSupportedLauncherProtocol(launcherProtocol)) {
    return {
      status: "blocked",
      version,
      // A stale `hyakki` earlier on PATH (an old npm/nvm global) makes `hyakki service install`
      // reinstall itself and report success, so name the exact install and the path check.
      reason: [
        `The installed service launcher speaks protocol ${launcherProtocol}, but hyakki@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://raw.githubusercontent.com/Ryoku-dev/hyakki/main/scripts/install.sh | HYAKKI_VERSION=${version} sh\`.`,
        `Check that \`hyakki --version\` prints ${version} and that \`which -a hyakki\` lists no older t3 (such as an npm or nvm install) first, then run \`~/.local/bin/hyakki service install\` (the installer's default path).`,
        "Updating the desktop app does not update this CLI, and `hyakki service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  const recorded = recordedMigrations(input.databasePath);
  if (recorded === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm hyakki@${version} supports it.`,
    };
  }
  const newer = recorded
    .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
    .map(({ id, name }) => `${id}_${name}`);
  if (newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that hyakki@${version} does not know: ${newer.join(", ")}. A newer build wrote them, and running hyakki@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
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
