import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";

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
 */
const isWindows = process.platform === "win32";

/** Quick `--version` style probes. */
export const PROVIDER_VERSION_PROBE_TIMEOUT_MS = isWindows ? 15_000 : 4_000;

/**
 * Codex app-server account/model probe.
 * Shared with {@link AUTH_PROBE_TIMEOUT_MS} in providerSnapshot for import stability.
 */
export const PROVIDER_AUTH_PROBE_TIMEOUT_MS = isWindows ? 45_000 : 15_000;

/** Cursor `agent about` (version + auth). Measured ~8–12s cold on Windows. */
export const CURSOR_ABOUT_TIMEOUT_MS = isWindows ? 45_000 : 20_000;

/** Cursor ACP model discovery after about succeeds. */
export const CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS = isWindows ? 45_000 : 20_000;

/** Grok `agent stdio` ACP initialize for model discovery. */
export const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = isWindows ? 45_000 : 20_000;

/**
 * Resolve a usable working directory for provider status probes.
 *
 * Electron/desktop backends can end up with a non-directory or inaccessible
 * `process.cwd()` (empty welcome state). Spawning with an invalid cwd on
 * Windows can hang instead of failing cleanly.
 */
export function resolveProviderProbeCwd(
  preferred?: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidates: Array<string | undefined> = [
    preferred?.trim() || undefined,
    environment.T3_PROVIDER_CWD?.trim() || undefined,
    environment.T3CODE_PROVIDER_CWD?.trim() || undefined,
    safeProcessCwd(),
    environment.USERPROFILE?.trim() || undefined,
    environment.HOME?.trim() || undefined,
    NodeOs.homedir(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (NodeFs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }

  // Last resort: absolute directory independent of process.cwd().
  // NodePath.resolve(".") calls process.cwd() and throws ENOENT when cwd is gone —
  // the exact failure mode this helper is meant to survive.
  return NodeOs.tmpdir();
}

function safeProcessCwd(): string | undefined {
  try {
    const cwd = process.cwd();
    return cwd.trim().length > 0 ? cwd : undefined;
  } catch {
    return undefined;
  }
}
