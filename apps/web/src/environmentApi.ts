import type { EnvironmentApi, EnvironmentId } from "@t3tools/contracts";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  return environmentApiOverridesForTests.get(environmentId);
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
