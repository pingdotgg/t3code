import type { ConnectionDiagnosticsSnapshot, ConnectionTroubleEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { NetworkStatus, SupervisorConnectionState } from "./model.ts";

export const CONNECTION_LOG_LIMIT = 50;
const DETAIL_LIMIT = 160;
const TROUBLE_REPORT_LIMIT = 10;

export interface ConnectionLogEvent {
  readonly diagnostics?: ConnectionDiagnosticsSnapshot;
  readonly appState?: ConnectionTroubleEvent["appState"];
  readonly at: number;
  readonly kind: "attempt" | "connected" | "failed" | "lost" | "waiting";
  readonly attempt: number;
  readonly route: string | null;
  readonly stage: SupervisorConnectionState["stage"];
  readonly reason: string | null;
  readonly detail: string | null;
  readonly network: NetworkStatus;
  readonly foreground: boolean | null;
}

/** Names the transition worth keeping, or null for progress within the same attempt. */
export function connectionLogKind(
  previous: SupervisorConnectionState,
  next: SupervisorConnectionState,
): ConnectionLogEvent["kind"] | null {
  if (next.phase === previous.phase && next.attempt === previous.attempt) return null;
  switch (next.phase) {
    case "connecting":
      return previous.phase === "connecting" && next.attempt === previous.attempt
        ? null
        : "attempt";
    case "connected":
      return "connected";
    case "backoff":
    case "blocked":
      return previous.phase === "connected" ? "lost" : "failed";
    case "offline":
      return "waiting";
    case "available":
      return null;
  }
}

export function appendConnectionLog(
  log: ReadonlyArray<ConnectionLogEvent>,
  event: ConnectionLogEvent,
): ReadonlyArray<ConnectionLogEvent> {
  const next = [...log, { ...event, detail: truncate(event.detail) }];
  return next.length > CONNECTION_LOG_LIMIT ? next.slice(-CONNECTION_LOG_LIMIT) : next;
}

/** Failures and losses after `since`, newest last, small enough to ride an activity report. */
export function connectionTroubleSince(
  log: ReadonlyArray<ConnectionLogEvent>,
  since: number,
): ReadonlyArray<ConnectionTroubleEvent> {
  return log
    .filter((event) => event.at > since && (event.kind === "failed" || event.kind === "lost"))
    .slice(-TROUBLE_REPORT_LIMIT)
    .map((event) => ({
      ...(event.diagnostics === undefined ? {} : { diagnostics: event.diagnostics }),
      ...(event.appState === undefined ? {} : { appState: event.appState }),
      ...(event.stage === null ? {} : { stage: event.stage }),
      at: event.at,
      kind: event.kind as ConnectionTroubleEvent["kind"],
      attempt: event.attempt,
      ...(event.route === null ? {} : { route: event.route }),
      ...(event.reason === null ? {} : { reason: event.reason }),
      ...(event.detail === null ? {} : { detail: event.detail }),
      network: event.network,
      ...(event.foreground === null ? {} : { foreground: event.foreground }),
    }));
}

export function formatConnectionLog(log: ReadonlyArray<ConnectionLogEvent>): string {
  return log
    .map((event) =>
      [
        DateTime.formatIso(DateTime.makeUnsafe(event.at)),
        event.kind,
        `#${event.attempt}`,
        event.route,
        event.stage,
        event.reason,
        event.detail,
        event.diagnostics === undefined ? null : JSON.stringify(event.diagnostics),
        event.appState ?? null,
        `net=${event.network}`,
        event.foreground === null ? null : event.foreground ? "fg" : "bg",
      ]
        .filter((part) => part !== null)
        .join(" "),
    )
    .join("\n");
}

function truncate(value: string | null): string | null {
  return value === null || value.length <= DETAIL_LIMIT
    ? value
    : `${value.slice(0, DETAIL_LIMIT - 1)}…`;
}
