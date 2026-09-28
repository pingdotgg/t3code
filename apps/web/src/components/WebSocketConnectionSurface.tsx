import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  getSlowRpcAckRequests,
  type SlowRpcAckRequest,
  useSlowRpcAckRequests,
} from "../rpc/requestLatencyState";
import { getLastWsStreamActivityMs, recordWsStreamActivity } from "../rpc/wsActivity";
import { recordWsDiagnostic } from "../rpc/wsDiagnostics";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
  type WsConnectionUiState,
  useWsConnectionStatus,
  WS_RECONNECT_MAX_ATTEMPTS,
} from "../rpc/wsConnectionState";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { reportClientWarning } from "../lib/clientLogger";
import {
  getPrimaryEnvironmentConnection,
  hasActiveThreadDetailWork,
  repairActiveThreadDetailSubscriptionsAfterStall,
} from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
/**
 * A socket that stays "open" while delivering zero bytes (no FIN/RST) parks
 * reads forever, so the reconnect loop never re-enters. Force a reconnect
 * after this long without any socket/stream activity while work is pending.
 */
export const WS_STALL_SILENCE_MS = 45_000;
/** Suppress toast flicker for blips that recover within this window. */
const RECONNECT_TOAST_DEBOUNCE_MS = 1_000;
/** Bound for the pre-reconnect responsiveness probe (see stall watchdog). */
const STALL_PROBE_TIMEOUT_MS = 10_000;
type WsAutoReconnectTrigger = "focus" | "online";

const connectionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

function formatConnectionMoment(isoDate: string | null): string | null {
  if (!isoDate) {
    return null;
  }

  return connectionTimeFormatter.format(new Date(isoDate));
}

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

function describeOfflineToast(): string {
  return "WebSocket disconnected. Waiting for network.";
}

function formatReconnectAttemptLabel(status: WsConnectionStatus): string {
  const reconnectAttempt = Math.max(
    1,
    Math.min(status.reconnectAttemptCount, WS_RECONNECT_MAX_ATTEMPTS),
  );
  return `Attempt ${reconnectAttempt}/${status.reconnectMaxAttempts}`;
}

function describeExhaustedToast(status: WsConnectionStatus): string {
  const detail = describeReconnectDetail(status);
  return detail
    ? `Retries exhausted trying to reconnect. Last error: ${detail}`
    : "Retries exhausted trying to reconnect";
}

function truncateReconnectDetail(detail: string, maxLength = 160): string {
  const trimmed = detail.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function describeReconnectDetail(status: WsConnectionStatus): string | null {
  const raw = status.lastError?.trim() || status.closeReason?.trim() || null;
  if (!raw) {
    return status.closeCode === null ? null : `close code ${status.closeCode}`;
  }
  const withCode = status.closeCode === null ? raw : `${raw} (close code ${status.closeCode})`;
  return truncateReconnectDetail(withCode);
}

function buildReconnectTitle(_status: WsConnectionStatus): string {
  return "Disconnected from T3 Server";
}

function describeRecoveredToast(
  previousDisconnectedAt: string | null,
  connectedAt: string | null,
): string {
  const reconnectedAtLabel = formatConnectionMoment(connectedAt);
  const disconnectedAtLabel = formatConnectionMoment(previousDisconnectedAt);

  if (disconnectedAtLabel && reconnectedAtLabel) {
    return `Disconnected at ${disconnectedAtLabel} and reconnected at ${reconnectedAtLabel}.`;
  }

  if (reconnectedAtLabel) {
    return `Connection restored at ${reconnectedAtLabel}.`;
  }

  return "Connection restored.";
}

function describeSlowRpcAckToast(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const requestCountsByTag = new Map<string, number>();

  for (const request of requests) {
    requestCountsByTag.set(request.tag, (requestCountsByTag.get(request.tag) ?? 0) + 1);
  }

  const topTags = Array.from(requestCountsByTag.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([tag, tagCount]) => `${tag} x${tagCount}`)
    .join(", ");

  return `${count} request${count === 1 ? "" : "s"} waiting past the RPC ack threshold. Methods: ${topTags}.`;
}

function SlowRpcAckRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  return (
    <ul className="space-y-2.5 text-xs text-muted-foreground">
      {requests.map((req) => (
        <li
          className="min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0"
          key={req.requestId}
        >
          <div className="wrap-break-word font-medium text-foreground">{req.tag}</div>
          <div className="mt-0.5 font-mono text-[10px] leading-snug opacity-90">
            {req.requestId}
          </div>
          <div className="mt-0.5 text-[10px] opacity-75">
            Started {formatConnectionMoment(req.startedAt) ?? req.startedAt}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  if (trigger === "online") {
    return (
      uiState === "offline" ||
      uiState === "reconnecting" ||
      uiState === "error" ||
      status.reconnectPhase === "exhausted"
    );
  }

  return (
    status.online &&
    status.hasConnected &&
    (uiState === "reconnecting" || status.reconnectPhase === "exhausted")
  );
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online &&
    status.hasConnected
  );
}

export function shouldForceStallReconnect(input: {
  readonly uiState: WsConnectionUiState;
  readonly lastActivityMs: number;
  readonly nowMs: number;
  readonly hasActiveWork: boolean;
  readonly silenceMs?: number;
}): boolean {
  const silenceMs = input.silenceMs ?? WS_STALL_SILENCE_MS;
  return (
    input.uiState === "connected" &&
    input.hasActiveWork &&
    Number.isFinite(input.lastActivityMs) &&
    input.nowMs - input.lastActivityMs >= silenceMs
  );
}
/**
 * Probe whether the primary connection still answers unary RPC before the
 * stall watchdog forces a reconnect. Silence alone is not evidence of a broken
 * socket: a legitimately long-running RPC (some are allowed minutes before
 * they even count as slow) produces no stream values while healthy.
 * Resolves true when the server answers, false on any failure or timeout so
 * the caller can reconnect only an actually unresponsive connection.
 */
async function probePrimaryConnectionResponsive(): Promise<boolean> {
  let connection: ReturnType<typeof getPrimaryEnvironmentConnection>;
  try {
    connection = getPrimaryEnvironmentConnection();
  } catch {
    return false;
  }
  let timeoutId: number | null = null;
  try {
    await Promise.race([
      connection.refreshShellSnapshot(),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("stall probe timed out")),
          STALL_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function shouldShowReconnectedToast(input: {
  readonly uiState: WsConnectionUiState;
  readonly previousUiState: WsConnectionUiState;
  readonly previousDisconnectedAt: string | null;
  readonly connectedAt: string | null;
  readonly debounceMs?: number;
}): boolean {
  if (
    input.uiState !== "connected" ||
    (input.previousUiState !== "offline" && input.previousUiState !== "reconnecting") ||
    input.previousDisconnectedAt === null
  ) {
    return false;
  }
  // Same debounce as the reconnecting/offline toasts: a sub-second blip shows
  // no reconnecting toast, so it must not show a "Reconnected" toast either.
  if (input.connectedAt === null) {
    return false;
  }
  const debounceMs = input.debounceMs ?? RECONNECT_TOAST_DEBOUNCE_MS;
  const durationMs =
    new Date(input.connectedAt).getTime() - new Date(input.previousDisconnectedAt).getTime();
  return Number.isFinite(durationMs) && durationMs >= debounceMs;
}

export function WebSocketConnectionCoordinator() {
  const status = useWsConnectionStatus();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastForcedReconnectAtRef = useRef(0);
  const lastStallReconnectAtRef = useRef(0);
  const stallProbeInFlightRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const toastResetTimerRef = useRef<number | null>(null);
  const previousUiStateRef = useRef<WsConnectionUiState>(getWsConnectionUiState(status));
  const previousDisconnectedAtRef = useRef<string | null>(status.disconnectedAt);

  const runReconnect = useEffectEvent((showFailureToast: boolean) => {
    if (toastResetTimerRef.current !== null) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }
    lastForcedReconnectAtRef.current = Date.now();
    void getPrimaryEnvironmentConnection()
      .reconnect()
      .catch((error) => {
        if (!showFailureToast) {
          reportClientWarning("Automatic WebSocket reconnect failed", { error });
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Reconnect failed",
            description:
              error instanceof Error ? error.message : "Unable to restart the WebSocket.",
            data: {
              dismissAfterVisibleMs: 8_000,
              hideCopyButton: true,
            },
          }),
        );
      });
  });
  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });
  const triggerManualReconnect = useEffectEvent(() => {
    runReconnect(true);
  });
  const triggerAutoReconnect = useEffectEvent((trigger: WsAutoReconnectTrigger) => {
    const currentStatus =
      trigger === "online" ? setBrowserOnlineStatus(true) : getWsConnectionStatus();

    if (!shouldAutoReconnect(currentStatus, trigger)) {
      return;
    }
    if (Date.now() - lastForcedReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
      return;
    }

    runReconnect(false);
  });

  useEffect(() => {
    const handleOnline = () => {
      triggerAutoReconnect("online");
    };
    const handleFocus = () => {
      triggerAutoReconnect("focus");
    };

    syncBrowserOnlineStatus();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", syncBrowserOnlineStatus);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", syncBrowserOnlineStatus);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (status.reconnectPhase !== "waiting" || status.nextRetryAt === null) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status.nextRetryAt, status.reconnectPhase]);

  useEffect(() => {
    if (
      status.reconnectPhase !== "waiting" ||
      status.nextRetryAt === null ||
      !status.online ||
      !status.hasConnected
    ) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect(false);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    status.hasConnected,
    status.nextRetryAt,
    status.online,
    status.reconnectAttemptCount,
    status.reconnectPhase,
  ]);

  useEffect(() => {
    if (getWsConnectionUiState(status) !== "connected") {
      return;
    }

    const intervalId = window.setInterval(() => {
      // Re-read fresh inside the tick: the effect closure captures render-time
      // state, so work that finishes before the next tick must not trigger a
      // reconnect. Active turns usually have no slow unary RPC
      // (`subscribeThread` is excluded from slow-request tracking and the
      // turn-start request may already have completed), so gate on locally
      // active thread work as well as slow requests.
      const hasActiveWork = getSlowRpcAckRequests().length > 0 || hasActiveThreadDetailWork();
      if (!hasActiveWork) {
        return;
      }
      const currentStatus = getWsConnectionStatus();
      if (
        !shouldForceStallReconnect({
          uiState: getWsConnectionUiState(currentStatus),
          lastActivityMs: getLastWsStreamActivityMs(),
          nowMs: Date.now(),
          hasActiveWork: true,
        })
      ) {
        return;
      }
      if (Date.now() - lastStallReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
        return;
      }
      if (stallProbeInFlightRef.current) {
        return;
      }
      stallProbeInFlightRef.current = true;
      void probePrimaryConnectionResponsive()
        .then((responsive) => {
          if (responsive) {
            // Unary success proves the socket answers, not that thread streams
            // are live: a zombie stream fiber stays pending forever without
            // failing its subscription loop. Repair active streams so the fresh
            // snapshot resyncs the timeline, and reset the silence clock so a
            // healthy long-running request isn't probed in a tight loop.
            repairActiveThreadDetailSubscriptionsAfterStall();
            recordWsStreamActivity();
            return;
          }
          lastStallReconnectAtRef.current = Date.now();
          recordWsDiagnostic("stream-stalled", {
            idleMs: Date.now() - getLastWsStreamActivityMs(),
            slowRequests: getSlowRpcAckRequests().length,
          });
          runReconnect(false);
        })
        .finally(() => {
          stallProbeInFlightRef.current = false;
        });
    }, 5_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status]);

  useEffect(() => {
    const uiState = getWsConnectionUiState(status);
    const previousUiState = previousUiStateRef.current;
    const previousDisconnectedAt = previousDisconnectedAtRef.current;
    const disconnectedAtMs = status.disconnectedAt
      ? new Date(status.disconnectedAt).getTime()
      : null;
    // Debounce blips: quick reconnects recover without any toast at all.
    const isDebounced =
      disconnectedAtMs === null || Date.now() - disconnectedAtMs >= RECONNECT_TOAST_DEBOUNCE_MS;
    const wouldShowReconnectToast = status.hasConnected && uiState === "reconnecting";
    const wouldShowOfflineToast = uiState === "offline" && status.disconnectedAt !== null;
    const wouldShowExhaustedToast = status.hasConnected && status.reconnectPhase === "exhausted";
    const shouldShowReconnectToast = isDebounced && wouldShowReconnectToast;
    const shouldShowOfflineToast = isDebounced && wouldShowOfflineToast;
    const shouldShowExhaustedToast = isDebounced && wouldShowExhaustedToast;

    // A sustained offline state produces no countdown ticks (the retry
    // countdown only runs while waiting with a nextRetryAt), so without a
    // timer the suppressed toast would never appear after the debounce window.
    if (wouldShowReconnectToast || wouldShowOfflineToast || wouldShowExhaustedToast) {
      if (!isDebounced && disconnectedAtMs !== null && debounceTimerRef.current === null) {
        const remainingMs = Math.max(
          0,
          RECONNECT_TOAST_DEBOUNCE_MS - (Date.now() - disconnectedAtMs),
        );
        debounceTimerRef.current = window.setTimeout(() => {
          debounceTimerRef.current = null;
          setNowMs(Date.now());
        }, remainingMs);
      }
    } else if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (
      toastResetTimerRef.current !== null &&
      (shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast)
    ) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }

    if (shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast) {
      const toastPayload = shouldShowOfflineToast
        ? stackedThreadToast({
            data: {
              hideCopyButton: true,
            },
            description: describeOfflineToast(),
            timeout: 0,
            title: "Offline",
            type: "warning",
          })
        : shouldShowExhaustedToast
          ? stackedThreadToast({
              actionProps: {
                children: "Retry",
                onClick: triggerManualReconnect,
              },
              data: {
                hideCopyButton: true,
              },
              description: describeExhaustedToast(status),
              timeout: 0,
              title: "Disconnected from T3 Server",
              type: "error",
            })
          : stackedThreadToast({
              actionProps: {
                children: "Retry now",
                onClick: triggerManualReconnect,
              },
              data: {
                hideCopyButton: true,
              },
              description: (() => {
                const base =
                  status.nextRetryAt === null
                    ? `Reconnecting... ${formatReconnectAttemptLabel(status)}`
                    : `Reconnecting in ${formatRetryCountdown(status.nextRetryAt, nowMs)}... ${formatReconnectAttemptLabel(status)}`;
                const detail = describeReconnectDetail(status);
                return detail ? `${base} — ${detail}` : base;
              })(),
              timeout: 0,
              title: buildReconnectTitle(status),
              type: "loading",
            });

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, toastPayload);
      } else {
        toastIdRef.current = toastManager.add(toastPayload);
      }
    } else if (toastIdRef.current) {
      toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    }

    if (
      shouldShowReconnectedToast({
        uiState,
        previousUiState,
        previousDisconnectedAt,
        connectedAt: status.connectedAt,
      })
    ) {
      const successToast = {
        description: describeRecoveredToast(previousDisconnectedAt, status.connectedAt),
        title: "Reconnected to T3 Server",
        type: "success" as const,
        timeout: 0,
        data: {
          dismissAfterVisibleMs: 8_000,
          hideCopyButton: true,
        },
      };

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, successToast);
      } else {
        toastIdRef.current = toastManager.add(successToast);
      }

      toastResetTimerRef.current = window.setTimeout(() => {
        toastIdRef.current = null;
        toastResetTimerRef.current = null;
      }, 8_250);
    }

    previousUiStateRef.current = uiState;
    previousDisconnectedAtRef.current = status.disconnectedAt;
  }, [nowMs, status]);

  useEffect(() => {
    return () => {
      if (toastResetTimerRef.current !== null) {
        window.clearTimeout(toastResetTimerRef.current);
      }
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return null;
}

export function SlowRpcAckToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  const status = useWsConnectionStatus();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (getWsConnectionUiState(status) !== "connected") {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    if (slowRequests.length === 0) {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    const nextToast = {
      data: {
        expandableContent: <SlowRpcAckRequestDetails requests={slowRequests} />,
        expandableDescriptionTrigger: true,
        expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
      },
      description: describeSlowRpcAckToast(slowRequests),
      timeout: 0,
      title: "Some requests are slow",
      type: "warning" as const,
    };

    if (toastIdRef.current) {
      toastManager.update(toastIdRef.current, nextToast);
    } else {
      toastIdRef.current = toastManager.add(nextToast);
    }
  }, [slowRequests, status]);

  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  return children;
}
