import type { PerfProviderScenarioId } from "@t3tools/shared/perf/scenarioCatalog";

export const PERF_PROVIDER_ENV = "T3CODE_PERF_PROVIDER";
export const PERF_SCENARIO_ENV = "T3CODE_PERF_SCENARIO";
const AUTO_BOOTSTRAP_PROJECT_ENV = "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD";

export function buildPerfServerEnv(
  baseEnv: NodeJS.ProcessEnv,
  providerScenarioId?: PerfProviderScenarioId,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    [AUTO_BOOTSTRAP_PROJECT_ENV]: "false",
  };

  if (!providerScenarioId) {
    delete env[PERF_PROVIDER_ENV];
    delete env[PERF_SCENARIO_ENV];
    return env;
  }

  return {
    ...env,
    [PERF_PROVIDER_ENV]: "1",
    [PERF_SCENARIO_ENV]: providerScenarioId,
  };
}
