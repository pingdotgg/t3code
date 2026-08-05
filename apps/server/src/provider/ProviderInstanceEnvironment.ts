import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface ProviderInstanceEnvironmentSource {
  readonly environment: NodeJS.ProcessEnv;
  readonly refresh: Effect.Effect<void>;
}

export function makeProviderInstanceEnvironmentSource(
  overrides: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ProviderInstanceEnvironmentSource {
  if (!overrides || overrides.length === 0) {
    return { environment: baseEnv, refresh: Effect.void };
  }

  const environment: NodeJS.ProcessEnv = {};
  const inheritedKeys = new Set<string>();
  const overrideKeys = new Set(overrides.map((variable) => variable.name));
  const apply = () => {
    for (const key of inheritedKeys) {
      if (!overrideKeys.has(key)) delete environment[key];
    }
    inheritedKeys.clear();
    for (const [key, value] of Object.entries(baseEnv)) {
      environment[key] = value;
      inheritedKeys.add(key);
    }
    for (const variable of overrides) {
      environment[variable.name] = variable.value;
    }
  };
  apply();

  return {
    environment,
    refresh: Effect.sync(apply),
  };
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return makeProviderInstanceEnvironmentSource(environment, baseEnv).environment;
}
