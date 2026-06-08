import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { isManagedRuntimeEnvKey, stripManagedRuntimeEnvKeys } from "../launchEnv/launchEnvUtils.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = stripManagedRuntimeEnvKeys(baseEnv);
  if (!environment || environment.length === 0) {
    return next;
  }

  for (const variable of environment) {
    if (isManagedRuntimeEnvKey(variable.name)) continue;
    next[variable.name] = variable.value;
  }
  return next;
}

export function mergeProviderSessionEnvironment(
  baseEnv: NodeJS.ProcessEnv | undefined,
  sessionEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const next = stripManagedRuntimeEnvKeys(baseEnv ?? process.env);
  if (!sessionEnv) return next;
  for (const [key, value] of Object.entries(sessionEnv)) {
    next[key] = value;
  }
  return next;
}
