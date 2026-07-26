/**
 * Provider turn-liveness defaults shared by runtime wiring and tests.
 *
 * The 15-minute stall threshold is a deliberate global default for every
 * provider wired through `TurnActivityWatchdog` (Codex, Claude, ACP, …), not
 * ACP-only slack: the product decision is to prefer fewer false stall
 * warnings, accepting that true hangs on chatty providers also wait 15
 * minutes before `session.health` and client notifications fire. The
 * watchdog is surfacing-only (it never interrupts turns), and
 * `T3CODE_TURN_STALL_THRESHOLD_MS` overrides the default per deployment.
 */

export const DEFAULT_TURN_STALL_THRESHOLD_MS = 15 * 60 * 1000;
export const TURN_STALL_POLL_INTERVAL_MS = 15_000;

function readNonNegativeIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Stall threshold. `0` disables stall events. */
export function readTurnStallThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeIntEnv(
    env,
    "T3CODE_TURN_STALL_THRESHOLD_MS",
    DEFAULT_TURN_STALL_THRESHOLD_MS,
  );
}
