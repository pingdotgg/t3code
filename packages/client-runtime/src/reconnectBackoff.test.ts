import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECONNECT_BACKOFF,
  getReconnectDelayMs,
  type ReconnectBackoffConfig,
} from "./reconnectBackoff";

describe("getReconnectDelayMs", () => {
  it("returns exponential delays with default config", () => {
    expect(getReconnectDelayMs(0)).toBe(1_000);
    expect(getReconnectDelayMs(1)).toBe(2_000);
    expect(getReconnectDelayMs(2)).toBe(4_000);
    expect(getReconnectDelayMs(3)).toBe(8_000);
    expect(getReconnectDelayMs(4)).toBe(16_000);
    expect(getReconnectDelayMs(5)).toBe(32_000);
    expect(getReconnectDelayMs(6)).toBe(64_000);
  });

  it("returns null when retry index exceeds maxRetries", () => {
    expect(getReconnectDelayMs(7)).toBeNull();
    expect(getReconnectDelayMs(100)).toBeNull();
  });

  it("returns null for negative indices", () => {
    expect(getReconnectDelayMs(-1)).toBeNull();
  });

  it("returns null for non-integer indices", () => {
    expect(getReconnectDelayMs(1.5)).toBeNull();
  });

  it("caps delay at maxDelayMs", () => {
    const config: ReconnectBackoffConfig = {
      initialDelayMs: 10_000,
      backoffFactor: 10,
      maxDelayMs: 30_000,
      maxRetries: 5,
    };

    expect(getReconnectDelayMs(0, config)).toBe(10_000);
    expect(getReconnectDelayMs(1, config)).toBe(30_000); // 100_000 capped to 30_000
    expect(getReconnectDelayMs(2, config)).toBe(30_000); // 1_000_000 capped to 30_000
  });

  it("supports unlimited retries when maxRetries is null", () => {
    const config: ReconnectBackoffConfig = {
      ...DEFAULT_RECONNECT_BACKOFF,
      maxRetries: null,
    };

    expect(getReconnectDelayMs(0, config)).toBe(1_000);
    expect(getReconnectDelayMs(50, config)).toBe(64_000); // capped at maxDelayMs
    expect(getReconnectDelayMs(100, config)).toBe(64_000);
  });
});

describe("DEFAULT_RECONNECT_BACKOFF", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_RECONNECT_BACKOFF.initialDelayMs).toBe(1_000);
    expect(DEFAULT_RECONNECT_BACKOFF.backoffFactor).toBe(2);
    expect(DEFAULT_RECONNECT_BACKOFF.maxDelayMs).toBe(64_000);
    expect(DEFAULT_RECONNECT_BACKOFF.maxRetries).toBe(7);
  });
});
