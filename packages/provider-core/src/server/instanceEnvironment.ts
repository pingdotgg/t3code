import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order, so an inherited HTTPS_PROXY would win over a configured Https_Proxy.
    if (windows) {
      for (const name of Object.keys(next)) {
        if (name !== variable.name && name.toUpperCase() === variable.name.toUpperCase()) {
          delete next[name];
        }
      }
    }
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
