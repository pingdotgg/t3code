import type { PerfProviderScenarioId } from "@t3tools/shared/perf/scenarioCatalog";

export const PERF_PROVIDER_ENV = "T3CODE_PERF_PROVIDER";
export const PERF_SCENARIO_ENV = "T3CODE_PERF_SCENARIO";
export const PERF_ARTIFACT_DIR_ENV = "T3CODE_PERF_ARTIFACT_DIR";
export const PERF_HEADFUL_ENV = "T3CODE_PERF_HEADFUL";

export function isPerfProviderEnabled(): boolean {
  return process.env[PERF_PROVIDER_ENV] === "1";
}

export function getPerfProviderScenarioId(): PerfProviderScenarioId | null {
  const rawScenarioId = process.env[PERF_SCENARIO_ENV]?.trim();
  if (rawScenarioId === "dense_assistant_stream" || rawScenarioId === "parallel_assistant_stream") {
    return rawScenarioId;
  }
  return null;
}
