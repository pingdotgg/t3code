import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import {
  isManagedRuntimeEnvKey,
  stripManagedRuntimeEnvKeys,
  type EnvRecord,
} from "../launchEnv/launchEnvUtils.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: EnvRecord = process.env,
): Record<string, string> {
  const next = stripManagedRuntimeEnvKeys(baseEnv);
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
  baseEnv: EnvRecord | undefined,
  sessionEnv: EnvRecord | undefined,
): Record<string, string> {
  const next = stripManagedRuntimeEnvKeys(baseEnv ?? process.env);
  if (!sessionEnv) return next;
  for (const [key, value] of Object.entries(sessionEnv)) {
    if (value !== undefined && !isManagedRuntimeEnvKey(key)) {
      next[key] = value;
    }
  }
  return next;
}
