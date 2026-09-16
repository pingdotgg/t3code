// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Resolve the working directory for Codex app-server provider probes.
 *
 * When T3 Code runs its backend inside WSL, the desktop bootstrap often leaves
 * `process.cwd()` on a Windows profile path mounted under `/mnt/…`. Codex's
 * `skills/list` probe can hang for many seconds on drvfs, which exceeds the
 * auth probe timeout and surfaces as "Timed out while checking Codex app-server
 * provider status." Prefer the Linux home directory in that case.
 */
export const resolveCodexProbeCwd = (
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  if (!cwd.startsWith("/mnt/")) {
    return cwd;
  }

  const home = environment.HOME?.trim() || NodeOS.homedir().trim();
  return home.length > 0 ? expandHomePath(home) : cwd;
};
