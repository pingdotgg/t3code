import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export function connectedDiagnosticsData<A>(isConnected: boolean, data: A | null): A | null {
  return isConnected ? data : null;
}

export function resolveDiagnosticsEnvironmentId(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly availableEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  const availableEnvironmentIds = new Set(input.availableEnvironmentIds);

  if (
    input.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(input.selectedEnvironmentId)
  ) {
    return input.selectedEnvironmentId;
  }
  if (
    input.primaryEnvironmentId !== null &&
    availableEnvironmentIds.has(input.primaryEnvironmentId)
  ) {
    return input.primaryEnvironmentId;
  }
  if (
    input.activeEnvironmentId !== null &&
    availableEnvironmentIds.has(input.activeEnvironmentId)
  ) {
    return input.activeEnvironmentId;
  }
  return input.availableEnvironmentIds[0] ?? null;
}

/**
 * Diagnostics queries only run while the selected environment has a connected
 * supervisor generation; otherwise they stay pending forever. Returns the
 * message to show instead of a loading state, or `null` when diagnostics can
 * actually be collected.
 */
export function diagnosticsConnectionNotice(input: {
  readonly phase: EnvironmentConnectionPhase;
  readonly label: string;
  readonly error: string | null;
}): string | null {
  switch (input.phase) {
    case "connected":
      return null;
    case "connecting":
      return `Connecting to ${input.label}...`;
    case "reconnecting":
      return input.error
        ? `Reconnecting to ${input.label}... Reason: ${input.error}`
        : `Reconnecting to ${input.label}...`;
    case "offline":
      return `${input.label} is offline. Diagnostics load once it reconnects.`;
    case "available":
      return `${input.label} is not connected. Diagnostics load once it connects.`;
    case "error":
      return input.error
        ? `Could not connect to ${input.label}. Reason: ${input.error}`
        : `Could not connect to ${input.label}.`;
  }
}

/**
 * An in-flight process signal. Signals are identified by environment as well as
 * pid so that a completion in one environment cannot clear pending state that
 * belongs to another one.
 */
export interface PendingProcessSignal {
  readonly environmentId: EnvironmentId;
  readonly pid: number;
}

function isSamePendingProcessSignal(left: PendingProcessSignal, right: PendingProcessSignal) {
  return left.environmentId === right.environmentId && left.pid === right.pid;
}

export function addPendingProcessSignal(
  pending: ReadonlyArray<PendingProcessSignal>,
  signal: PendingProcessSignal,
): ReadonlyArray<PendingProcessSignal> {
  return pending.some((entry) => isSamePendingProcessSignal(entry, signal))
    ? pending
    : [...pending, signal];
}

export function removePendingProcessSignal(
  pending: ReadonlyArray<PendingProcessSignal>,
  signal: PendingProcessSignal,
): ReadonlyArray<PendingProcessSignal> {
  const next = pending.filter((entry) => !isSamePendingProcessSignal(entry, signal));
  return next.length === pending.length ? pending : next;
}

export function pendingProcessSignalPids(
  pending: ReadonlyArray<PendingProcessSignal>,
  environmentId: EnvironmentId | null,
): ReadonlySet<number> {
  return new Set(
    pending
      .filter((entry) => environmentId !== null && entry.environmentId === environmentId)
      .map((entry) => entry.pid),
  );
}
