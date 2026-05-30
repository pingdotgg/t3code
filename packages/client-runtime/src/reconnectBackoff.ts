/**
 * Configuration for exponential reconnect backoff.
 */
export interface ReconnectBackoffConfig {
  /** Base delay in milliseconds before the first retry. */
  readonly initialDelayMs: number;
  /** Multiplier applied per retry (exponential factor). */
  readonly backoffFactor: number;
  /** Hard upper bound on delay in milliseconds. */
  readonly maxDelayMs: number;
  /** Maximum number of retries (0-based). `null` means unlimited. */
  readonly maxRetries: number | null;
}

/**
 * Sensible defaults for WebSocket reconnect backoff.
 *
 * - 1 s initial delay, doubling each retry, capped at 64 s, up to 7 retries.
 */
export const DEFAULT_RECONNECT_BACKOFF: ReconnectBackoffConfig = {
  initialDelayMs: 1_000,
  backoffFactor: 2,
  maxDelayMs: 64_000,
  maxRetries: 7,
};

/**
 * Calculate the reconnect delay for a given retry index using exponential
 * backoff. Returns `null` when `retryIndex` exceeds the configured maximum.
 */
export function getReconnectDelayMs(
  retryIndex: number,
  config: ReconnectBackoffConfig = DEFAULT_RECONNECT_BACKOFF,
): number | null {
  if (!Number.isInteger(retryIndex) || retryIndex < 0) {
    return null;
  }

  if (config.maxRetries !== null && retryIndex >= config.maxRetries) {
    return null;
  }

  return Math.min(
    Math.round(config.initialDelayMs * config.backoffFactor ** retryIndex),
    config.maxDelayMs,
  );
}
