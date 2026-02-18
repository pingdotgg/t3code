type PerfToggleEnv = {
  T3CODE_DESKTOP_PERF_RUN_TERMINAL?: string | undefined;
  CI?: string | undefined;
};

type OptionalRendererToggleEnv = {
  T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER?: string | undefined;
  CI?: string | undefined;
};

type PerfBenchmarkEnv = {
  T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES?: string | undefined;
  CI?: string | undefined;
};

type BenchmarkSweepToggleEnv = {
  T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP?: string | undefined;
  CI?: string | undefined;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
// Avoid pathological workload from misconfigured env overrides in CI.
const MAX_BENCHMARK_FOLLOW_UP_PASSES = 5;

function parseBooleanLike(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function isCiEnvironment(value: string | undefined): boolean {
  return parseBooleanLike(value) === true;
}

function resolveBooleanToggle(rawValue: string | undefined, ciValue: string | undefined): boolean {
  const toggleOverride = parseBooleanLike(rawValue);
  if (toggleOverride !== null) return toggleOverride;
  return !isCiEnvironment(ciValue);
}

/**
 * Controls whether desktop perf automation should include terminal shortcuts.
 *
 * Accepted explicit env values:
 * - truthy: "1", "true", "yes", "on"
 * - falsy: "0", "false", "no", "off"
 *
 * Defaults to "on" for local/dev runs, but "off" in CI unless explicitly enabled.
 * This keeps CI perf checks focused on renderer responsiveness while avoiding
 * flaky PTY-dependent interactions in ephemeral Linux runners.
 */
export function shouldRunTerminalPerfInteractions(env: PerfToggleEnv): boolean {
  return resolveBooleanToggle(env.T3CODE_DESKTOP_PERF_RUN_TERMINAL, env.CI);
}

export function shouldRunOptionalRendererPerfInteractions(env: OptionalRendererToggleEnv): boolean {
  return resolveBooleanToggle(env.T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER, env.CI);
}

/**
 * Controls high-variance benchmark thread switching loops.
 * Defaults off in CI, on locally, with explicit env override support.
 */
export function shouldRunBenchmarkThreadSweep(env: BenchmarkSweepToggleEnv): boolean {
  return resolveBooleanToggle(env.T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP, env.CI);
}

/**
 * Resolves number of follow-up benchmark passes.
 * - explicit non-negative integer env override wins
 * - value is capped for safety
 * - otherwise defaults to 0 in CI and 1 locally
 */
export function resolveBenchmarkFollowUpPassCount(env: PerfBenchmarkEnv): number {
  const raw = env.T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    return Math.min(parsed, MAX_BENCHMARK_FOLLOW_UP_PASSES);
  }
  return isCiEnvironment(env.CI) ? 0 : 1;
}
