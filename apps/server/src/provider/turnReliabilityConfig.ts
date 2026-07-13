/** Provider turn-liveness defaults shared by runtime wiring and tests. */

export const DEFAULT_TURN_STALL_THRESHOLD_MS = 120_000;
export const TURN_STALL_POLL_INTERVAL_MS = 15_000;

function readNonNegativeIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Stall threshold. `0` disables stall events. */
export function readTurnStallThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeIntEnv(
    env,
    "T3CODE_TURN_STALL_THRESHOLD_MS",
    DEFAULT_TURN_STALL_THRESHOLD_MS,
  );
}
