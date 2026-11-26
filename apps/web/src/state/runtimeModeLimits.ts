import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderRuntimeModeLimit,
} from "@t3tools/contracts";
import { createContext } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export interface RuntimeModeLimitsTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}

const NO_LIMITS: ReadonlyArray<ProviderRuntimeModeLimit> = [];

/** The folder and provider whose limits an open mode picker should check again. */
export const RuntimeModeLimitsTargetContext = createContext<RuntimeModeLimitsTarget | null>(null);

export function runtimeModeLimitsTarget(
  environmentId: EnvironmentId | null,
  instanceId: ProviderInstanceId | undefined,
  cwd: string | null,
): RuntimeModeLimitsTarget | null {
  return environmentId && instanceId && cwd ? { environmentId, instanceId, cwd } : null;
}

/**
 * Modes the provider offers that cannot run in `target`'s folder. Empty until the server
 * answers and when it cannot, so a mode is only ever marked on a known reason. `mountScope`
 * gives a second reader its own mount, which asks again when the answer is a few seconds old.
 */
export function useProviderRuntimeModeLimits(
  target: RuntimeModeLimitsTarget | null,
  mountScope?: "picker",
): ReadonlyArray<ProviderRuntimeModeLimit> {
  const { data } = useEnvironmentQuery(
    target === null
      ? null
      : serverEnvironment.providerRuntimeModeLimits(
          {
            environmentId: target.environmentId,
            input: { instanceId: target.instanceId, cwd: target.cwd },
          },
          mountScope,
        ),
  );
  return data?.limits ?? NO_LIMITS;
}
