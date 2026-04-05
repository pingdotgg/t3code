import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exhaustWsReconnectIfStillWaiting,
  getWsConnectionStatus,
  getWsReconnectDelayMsForRetry,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
  WS_RECONNECT_MAX_ATTEMPTS,
} from "./wsConnectionState";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a disconnected browser as offline once the websocket drops", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1006, reason: "offline" });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("offline");
  });

  it("stays in the initial connecting state until the first disconnect", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");

    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      hasConnected: false,
      phase: "connecting",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connecting");
  });

  it("schedules the next retry after a failed websocket attempt", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");

    const firstRetryDelayMs = getWsReconnectDelayMsForRetry(0);
    if (firstRetryDelayMs === null) {
      throw new Error("Expected an initial retry delay.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: new Date(Date.now() + firstRetryDelayMs).toISOString(),
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("marks the reconnect cycle as exhausted after the final attempt fails", () => {
    for (let attempt = 0; attempt < WS_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: null,
      reconnectAttemptCount: WS_RECONNECT_MAX_ATTEMPTS,
      reconnectPhase: "exhausted",
    });
  });

  it("can exhaust a stalled final retry window when no new attempt starts", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();

    for (let attempt = 0; attempt < WS_RECONNECT_MAX_ATTEMPTS - 1; attempt += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");
    }

    const finalRetryDelayMs = getWsReconnectDelayMsForRetry(WS_RECONNECT_MAX_ATTEMPTS - 2);
    if (finalRetryDelayMs === null) {
      throw new Error("Expected a final retry delay.");
    }

    const statusBeforeExhaust = getWsConnectionStatus();
    expect(statusBeforeExhaust).toMatchObject({
      nextRetryAt: new Date(Date.now() + finalRetryDelayMs).toISOString(),
      reconnectAttemptCount: 7,
      reconnectPhase: "waiting",
    });

    const nextRetryAt = statusBeforeExhaust.nextRetryAt;
    if (!nextRetryAt) {
      throw new Error("Expected a scheduled retry.");
    }

    vi.setSystemTime(new Date(Date.now() + finalRetryDelayMs + 1_000));
    exhaustWsReconnectIfStillWaiting(nextRetryAt);

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: null,
      reconnectAttemptCount: WS_RECONNECT_MAX_ATTEMPTS,
      reconnectPhase: "exhausted",
    });
  });
});
