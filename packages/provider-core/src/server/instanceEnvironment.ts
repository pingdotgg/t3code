import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { stripAppImageRuntimeEnv } from "./appImageRuntimeEnv.ts";
import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  // Agents and the shells they start get the user's environment, not the
  // AppImage runtime's. The packaged server runs as Electron-as-Node; an agent
  // that inherits that flag starts Node when it re-executes the app binary.
  // Spawns that need it set it explicitly.
  const next: NodeJS.ProcessEnv = { ...stripAppImageRuntimeEnv(baseEnv) };
  delete next.ELECTRON_RUN_AS_NODE;
  if (!environment || environment.length === 0) return next;

  const home = yield* HostProcess.HomeDirectory;
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
