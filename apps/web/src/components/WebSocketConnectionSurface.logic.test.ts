import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  shouldAutoReconnect,
  shouldForceStallReconnect,
  shouldRestartStalledReconnect,
  WS_STALL_SILENCE_MS,
} from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });

  it("forces a stall reconnect only when connected with active work and silence", () => {
    const nowMs = 1_000_000;
    expect(
      shouldForceStallReconnect({
        uiState: "connected",
        lastActivityMs: nowMs - WS_STALL_SILENCE_MS - 1,
        nowMs,
        hasActiveWork: true,
      }),
    ).toBe(true);

    expect(
      shouldForceStallReconnect({
        uiState: "connected",
        lastActivityMs: nowMs - 1_000,
        nowMs,
        hasActiveWork: true,
      }),
    ).toBe(false);

    expect(
      shouldForceStallReconnect({
        uiState: "connected",
        lastActivityMs: nowMs - WS_STALL_SILENCE_MS - 1,
        nowMs,
        hasActiveWork: false,
      }),
    ).toBe(false);

    expect(
      shouldForceStallReconnect({
        uiState: "reconnecting",
        lastActivityMs: nowMs - WS_STALL_SILENCE_MS - 1,
        nowMs,
        hasActiveWork: true,
      }),
    ).toBe(false);
  });
});
