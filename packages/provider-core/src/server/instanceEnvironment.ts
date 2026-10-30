import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { stripAppImageRuntimeEnv } from "./appImageRuntimeEnv.ts";
import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  // The server uses Electron as Node; only T3-owned launchers should inherit that mode.
  const next: NodeJS.ProcessEnv = { ...stripAppImageRuntimeEnv(baseEnv) };
  delete next.ELECTRON_RUN_AS_NODE;
  if (!environment || environment.length === 0) return next;

  const home = yield* HostProcess.HomeDirectory;
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
