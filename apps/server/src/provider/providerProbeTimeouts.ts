import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as Effect from "effect/Effect";
import {
  HostProcessEnvironment,
  HostProcessWorkingDirectory,
  isHostWindows,
} from "@t3tools/shared/hostProcess";

/**
 * Provider status probes spawn local CLIs over stdio/ACP.
 *
 * On Windows, cold starts are substantially slower:
 * - Cursor `agent about` commonly takes 7–12s (PowerShell + Node bootstrap)
 * - Parallel Codex/Grok ACP handshakes compete for CPU/disk during desktop startup
 * - Leaving stdin open can keep non-interactive probes waiting until timeout
 *
 * Timeouts below are deliberately higher on win32 so healthy installs are not
 * reported as "Unavailable" during normal machine load.
 *
 * Prefer the Effect forms at probe sites (`yield* providerAuthProbeTimeoutMs`) so
 * platform comes from `HostProcessPlatform` and tests can override it.
 */

/** Pure helpers for message construction and unit tests. */
export function providerVersionProbeTimeoutMsFor(isWindows: boolean): number {
  return isWindows ? 15_000 : 4_000;
}

export function providerAuthProbeTimeoutMsFor(isWindows: boolean): number {
  return isWindows ? 45_000 : 15_000;
}

export function cursorAboutTimeoutMsFor(isWindows: boolean): number {
  return isWindows ? 45_000 : 20_000;
}

export function cursorAcpModelDiscoveryTimeoutMsFor(isWindows: boolean): number {
  return isWindows ? 45_000 : 20_000;
}

export function grokAcpModelDiscoveryTimeoutMsFor(isWindows: boolean): number {
  return isWindows ? 45_000 : 20_000;
}

/** Quick `--version` style probes. */
export const providerVersionProbeTimeoutMs = Effect.map(
  isHostWindows,
  providerVersionProbeTimeoutMsFor,
);

/**
 * Codex app-server account/model probe.
 */
export const providerAuthProbeTimeoutMs = Effect.map(isHostWindows, providerAuthProbeTimeoutMsFor);

/** Cursor `agent about` (version + auth). Measured ~8–12s cold on Windows. */
export const cursorAboutTimeoutMs = Effect.map(isHostWindows, cursorAboutTimeoutMsFor);

/** Cursor ACP model discovery after about succeeds. */
export const cursorAcpModelDiscoveryTimeoutMs = Effect.map(
  isHostWindows,
  cursorAcpModelDiscoveryTimeoutMsFor,
);

/** Grok `agent stdio` ACP initialize for model discovery. */
export const grokAcpModelDiscoveryTimeoutMs = Effect.map(
  isHostWindows,
  grokAcpModelDiscoveryTimeoutMsFor,
);

/**
 * True when `path` is a directory the process can read (and therefore use as cwd).
 * `stat` alone is not enough: ACL-denied dirs still look like directories.
 */
export function isUsableProbeDirectory(path: string): boolean {
  try {
    if (!NodeFs.statSync(path).isDirectory()) {
      return false;
    }
    NodeFs.accessSync(path, NodeFs.constants.R_OK);
    // Confirm we can actually enter/list — closer to spawn-with-cwd success.
    NodeFs.readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a usable working directory for provider status probes.
 *
 * Electron/desktop backends can end up with a non-directory or inaccessible
 * working directory (empty welcome state). Spawning with an invalid cwd on
 * Windows can hang or fail instead of failing cleanly.
 *
 * Pure (sync) form — prefer {@link resolveProviderProbeCwd} Effect for new call sites
 * that already run inside Effect.gen. Pass `workingDirectory` from
 * `HostProcessWorkingDirectory` when available; do not read `process.cwd()` here.
 */
export function resolveProviderProbeCwdSync(
  preferred?: string | null,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory?: string | null,
): string {
  const candidates: Array<string | undefined> = [
    preferred?.trim() || undefined,
    environment.T3_PROVIDER_CWD?.trim() || undefined,
    environment.T3CODE_PROVIDER_CWD?.trim() || undefined,
    workingDirectory?.trim() || undefined,
    environment.USERPROFILE?.trim() || undefined,
    environment.HOME?.trim() || undefined,
    NodeOs.homedir(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isUsableProbeDirectory(candidate)) {
      return candidate;
    }
  }

  // Last resort: absolute directory independent of process.cwd().
  return NodeOs.tmpdir();
}

/**
 * Effect form: env from `HostProcessEnvironment` (unless overridden) and
 * working directory from `HostProcessWorkingDirectory`.
 */
export const resolveProviderProbeCwd = Effect.fn("resolveProviderProbeCwd")(function* (
  preferred?: string | null,
  environment?: NodeJS.ProcessEnv,
) {
  const env = environment ?? (yield* HostProcessEnvironment);
  // HostProcessWorkingDirectory is typed as infallible, but its defaultValue
  // calls process.cwd() which can throw a defect when cwd is gone. Catch only
  // defects (not fiber interrupts) so cancelled probes still stop promptly.
  const workingDirectory = yield* Effect.map(HostProcessWorkingDirectory, (cwd) =>
    cwd.trim().length > 0 ? cwd : undefined,
  ).pipe(Effect.catchDefect(() => Effect.succeed(undefined as string | undefined)));
  return resolveProviderProbeCwdSync(preferred, env, workingDirectory);
});
