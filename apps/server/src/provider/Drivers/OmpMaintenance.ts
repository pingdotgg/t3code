/**
 * OmpMaintenance — update capabilities and workspace-snapshot helpers for the
 * Oh My Pi (`omp`) driver.
 *
 * omp is its own updater: `omp update` detects how this copy was installed
 * (Homebrew, mise, Bun, npm, or a direct binary) and delegates to it, so no
 * single registry describes the install. `omp update --check` prints the
 * installed version (`Current version: X`) and, when behind, the version it
 * would install (`New version available: Y`). The maintenance resolver
 * therefore advertises the resolved `omp` binary itself as the updater and
 * bakes the `--check` output into `latestVersion`, instead of guessing a
 * registry the way npm/homebrew-backed drivers do.
 *
 * @module provider/Drivers/OmpMaintenance
 */
import { ProviderDriverKind, type ServerProviderWorkspaceSnapshot } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

/** Retained per-cwd catalogs, mirroring the Antigravity driver's cap. */
export const OMP_MAX_WORKSPACE_SNAPSHOTS = 32;

const OMP_UPDATE_CHECK_TIMEOUT_MS = 10_000;
const OMP_UPDATE_CHECK_MAX_BYTES = 64 * 1024;

export interface OmpUpdateCheckVersions {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}

const CURRENT_VERSION_PATTERN = /Current version:\s*v?(\d+\.\d+\.\d+)/i;
const LATEST_VERSION_PATTERNS = [
  /New version available:\s*v?(\d+\.\d+\.\d+)/i,
  /Latest version:\s*v?(\d+\.\d+\.\d+)/i,
  /Available version:\s*v?(\d+\.\d+\.\d+)/i,
] as const;

/**
 * Split `omp update --check` output into the installed version and the
 * version an update would install. A missing "new version" line means omp
 * considers itself current, so `latestVersion` stays null and callers fall
 * back to `currentVersion`.
 */
export function parseOmpUpdateCheck(output: string): OmpUpdateCheckVersions {
  const currentVersion = CURRENT_VERSION_PATTERN.exec(output)?.[1] ?? null;
  let latestVersion: string | null = null;
  for (const pattern of LATEST_VERSION_PATTERNS) {
    const match = pattern.exec(output);
    if (match?.[1]) {
      latestVersion = match[1];
      break;
    }
  }
  return { currentVersion, latestVersion };
}

/**
 * Record one workspace catalog, keeping earlier workspaces so snapshot
 * refreshes never drop a cwd the composer already resolved. Same shape as
 * the Antigravity precedent: replace the entry for a revisited cwd, evict
 * the least recently recorded workspaces past the cap.
 */
export function appendOmpWorkspaceSnapshot(
  previous: ReadonlyArray<ServerProviderWorkspaceSnapshot>,
  entry: ServerProviderWorkspaceSnapshot,
  maxSnapshots: number = OMP_MAX_WORKSPACE_SNAPSHOTS,
): Array<ServerProviderWorkspaceSnapshot> {
  return [...previous.filter((snapshot) => snapshot.cwd !== entry.cwd), entry].slice(-maxSnapshots);
}

/**
 * Run `omp update --check` and return its combined output, or null when omp
 * fails, times out, or floods the pipe. A null never blocks the update
 * button — the capability is still advertised with an unknown latest.
 */
const runOmpUpdateCheck = Effect.fn("OmpMaintenance.runUpdateCheck")(function* (
  executable: string,
  env: NodeJS.ProcessEnv,
) {
  const spawnCommand = yield* resolveSpawnCommand(executable, ["update", "--check"], { env });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        extendEnv: true,
        shell: spawnCommand.shell,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    // stderr rides along: update advisories may print to either stream.
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: OMP_UPDATE_CHECK_MAX_BYTES }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: OMP_UPDATE_CHECK_MAX_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0 || stdout.truncated || stderr.truncated) {
      return null;
    }
    return `${stdout.text}\n${stderr.text}`;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(OMP_UPDATE_CHECK_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi update check failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

/**
 * omp updates itself, so the resolved executable is its own updater — the
 * Cursor precedent with an `--check`-derived latest version on top. No
 * resolvable binary means nothing to update, not "whatever is on PATH".
 */
export function makeOmpMaintenanceResolver(): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) =>
      Effect.gen(function* () {
        if (!context) {
          return makeManualOnlyProviderMaintenanceCapabilities({
            provider: OMP_DRIVER_KIND,
            packageName: null,
          });
        }
        const output = yield* runOmpUpdateCheck(context.resolvedCommandPath, context.env);
        const parsed = output === null ? null : parseOmpUpdateCheck(output);
        return makeProviderMaintenanceCapabilities({
          provider: OMP_DRIVER_KIND,
          packageName: null,
          updateExecutable: context.resolvedCommandPath,
          updateArgs: ["update"],
          updateLockKey: "omp",
          platform: context.platform,
          // No "new version" line means omp reports itself current; a failed
          // probe leaves latest unknown rather than guessing a registry.
          latestVersion: parsed ? (parsed.latestVersion ?? parsed.currentVersion) : null,
        });
      }),
  };
}
