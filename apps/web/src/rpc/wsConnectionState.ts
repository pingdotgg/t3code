import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_RECONNECT_BACKOFF, getReconnectDelayMs } from "@t3tools/client-runtime";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export type WsConnectionUiState = "connected" | "connecting" | "error" | "offline" | "reconnecting";
export type WsReconnectPhase = "attempting" | "exhausted" | "idle" | "waiting";

export const WS_RECONNECT_INITIAL_DELAY_MS = DEFAULT_RECONNECT_BACKOFF.initialDelayMs;
export const WS_RECONNECT_BACKOFF_FACTOR = DEFAULT_RECONNECT_BACKOFF.backoffFactor;
export const WS_RECONNECT_MAX_DELAY_MS = DEFAULT_RECONNECT_BACKOFF.maxDelayMs;
export const WS_RECONNECT_MAX_RETRIES = DEFAULT_RECONNECT_BACKOFF.maxRetries!;
export const WS_RECONNECT_MAX_ATTEMPTS = WS_RECONNECT_MAX_RETRIES + 1;

export interface WsConnectionStatus {
  readonly attemptCount: number;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly connectionLabel: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly hasConnected: boolean;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly online: boolean;
  readonly phase: "idle" | "connecting" | "connected" | "disconnected";
  readonly reconnectAttemptCount: number;
  readonly reconnectMaxAttempts: number;
  readonly reconnectPhase: WsReconnectPhase;
  readonly socketUrl: string | null;
}

const INITIAL_WS_CONNECTION_STATUS = Object.freeze<WsConnectionStatus>({
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectionLabel: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  phase: "idle",
  reconnectAttemptCount: 0,
  reconnectMaxAttempts: WS_RECONNECT_MAX_ATTEMPTS,
  reconnectPhase: "idle",
  socketUrl: null,
});

export const wsConnectionStatusAtom = Atom.make(INITIAL_WS_CONNECTION_STATUS).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-status"),
);

function isoNow() {
  return new Date().toISOString();
}

function updateWsConnectionStatus(
  updater: (current: WsConnectionStatus) => WsConnectionStatus,
): WsConnectionStatus {
  const nextStatus = updater(getWsConnectionStatus());
  appAtomRegistry.set(wsConnectionStatusAtom, nextStatus);
  return nextStatus;
}

export interface WsConnectionMetadata {
  readonly connectionLabel?: string | null;
  readonly versionMismatchHint?: string | null;
}

function normalizeConnectionLabel(label: string | null | undefined): string | null {
  const normalized = label?.trim();
  return normalized ? normalized : null;
}

export function getWsConnectionStatus(): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusAtom);
}

export function getWsConnectionUiState(status: WsConnectionStatus): WsConnectionUiState {
  if (status.phase === "connected") {
    return "connected";
  }

  if (!status.online && (status.disconnectedAt !== null || status.phase === "disconnected")) {
    return "offline";
  }

  if (!status.hasConnected) {
    return status.phase === "disconnected" ? "error" : "connecting";
  }

  return "reconnecting";
}

export function recordWsConnectionAttempt(
  socketUrl: string,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  return updateWsConnectionStatus((current) => ({
    ...current,
    attemptCount: current.attemptCount + 1,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    nextRetryAt: null,
    phase: "connecting",
    reconnectAttemptCount: current.phase === "connected" ? 1 : current.reconnectAttemptCount + 1,
    reconnectPhase: "attempting",
    socketUrl,
  }));
}

export function recordWsConnectionOpened(metadata?: WsConnectionMetadata): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  return updateWsConnectionStatus((current) => ({
    ...current,
    closeCode: null,
    closeReason: null,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    connectedAt: isoNow(),
    disconnectedAt: null,
    hasConnected: true,
    nextRetryAt: null,
    phase: "connected",
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

function appendHint(message: string | null | undefined, hint: string | null | undefined) {
  const normalizedMessage = message?.trim();
  const normalizedHint = hint?.trim();
  if (!normalizedMessage) {
    return normalizedHint ? `Hint: ${normalizedHint}` : null;
  }
  return normalizedHint ? `${normalizedMessage} Hint: ${normalizedHint}` : normalizedMessage;
}

export function recordWsConnectionErrored(
  message?: string | null,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      lastError:
        appendHint(message, metadata?.versionMismatchHint) ??
        appendHint(current.lastError, metadata?.versionMismatchHint),
      lastErrorAt: isoNow(),
    }),
  );
}

export function recordWsConnectionClosed(
  details?: {
    readonly code?: number;
    readonly reason?: string;
  },
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(
      current,
      {
        closeCode: details?.code ?? current.closeCode,
        closeReason:
          appendHint(details?.reason, metadata?.versionMismatchHint) ??
          appendHint(current.closeReason, metadata?.versionMismatchHint),
      },
      connectionLabel === null ? undefined : { connectionLabel },
    ),
  );
}

export function setBrowserOnlineStatus(online: boolean): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    online,
  }));
}

export function resetWsReconnectBackoff(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

export function resetWsConnectionStateForTests(): void {
  appAtomRegistry.set(wsConnectionStatusAtom, INITIAL_WS_CONNECTION_STATUS);
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

export function getWsReconnectDelayMsForRetry(retryIndex: number): number | null {
  return getReconnectDelayMs(retryIndex);
}

function applyDisconnectState(
  current: WsConnectionStatus,
  updates: Partial<
    Pick<WsConnectionStatus, "closeCode" | "closeReason" | "lastError" | "lastErrorAt">
  >,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const disconnectedAt = current.disconnectedAt ?? isoNow();
  const nextRetryDelayMs =
    current.nextRetryAt !== null || current.reconnectPhase === "exhausted"
      ? null
      : getWsReconnectDelayMsForRetry(Math.max(0, current.reconnectAttemptCount - 1));

  return {
    ...current,
    ...updates,
    connectionLabel: normalizeConnectionLabel(metadata?.connectionLabel) ?? current.connectionLabel,
    disconnectedAt,
    nextRetryAt:
      nextRetryDelayMs === null
        ? current.nextRetryAt
        : new Date(Date.now() + nextRetryDelayMs).toISOString(),
    phase: "disconnected",
    reconnectPhase:
      current.reconnectPhase === "waiting" || current.reconnectPhase === "exhausted"
        ? current.reconnectPhase
        : nextRetryDelayMs === null
          ? "exhausted"
          : "waiting",
  };
}
