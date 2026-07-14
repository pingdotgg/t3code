import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  globalEnvironment: ProviderInstanceEnvironment | undefined = undefined,
): NodeJS.ProcessEnv {
  if (
    (!globalEnvironment || globalEnvironment.length === 0) &&
    (!environment || environment.length === 0)
  ) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of globalEnvironment ?? []) {
    next[variable.name] = variable.value;
  }
  for (const variable of environment ?? []) {
    next[variable.name] = variable.value;
  }
  return next;
}
