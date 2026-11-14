import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OrbitGatewayError,
  operationPollDelayMs,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
} from "./client.ts";
import {
  observeOrbitCompletionRows,
  reopenOrbitCompletionRows,
  type OrbitCreateRows,
} from "./orbitCreateRows.ts";
import {
  orbitCancelledCompletionShowsFailure,
  orbitPlusStartFollowsCompletion,
} from "./orbitCompletionPolicy.ts";
import { orbitThreadStartHasNoMessage, type OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: the create's `instance.complete` (Orbit release 2030). The create ends once the thread is
 * usable; this second Operation installs the Processes, fills the database and publishes the
 * Route. The setup card in the thread follows it. Its outcome lives in the start's `completion*`
 * fields, never in `error`: the thread and the composer stay usable whatever it does.
 */

/** Where the completion of a start is, for the card. */
export type OrbitCompletionPhase =
  /** No completion: an older Gateway, or a start in an existing Instance. */
  | "none"
  | "running"
  | "succeeded"
  | "failed"
  /** Cancelled by a removal: nothing new shows; the removal takes the thread away. */
  | "removed";

export function orbitCompletionPhase(start: OrbitThreadStart): OrbitCompletionPhase {
  // A Retry Orbit has not answered yet has a key and no Operation id: it runs.
  if (start.completionOperationId == null && start.completionKey == null) return "none";
  switch (start.completionStatus ?? "queued") {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return start.completionRetryable === true && orbitCancelledCompletionShowsFailure()
        ? "failed"
        : "removed";
    default:
      return "running";
  }
}

/** Whether the main window's runner follows this start's completion. */
export function orbitCompletionNeedsFollow(start: OrbitThreadStart): boolean {
  return (
    start.sentAt != null &&
    start.pendingThread === true &&
    start.completionOperationId != null &&
    !OPERATION_TERMINAL_STATUSES.has(start.completionStatus ?? "queued") &&
    (!orbitThreadStartHasNoMessage(start) || orbitPlusStartFollowsCompletion())
  );
}

/**
 * A Retry sent but not answered (a reload or quit came first): the runner sends it again under
 * the saved key, and Orbit returns the Operation it may have admitted.
 */
export function orbitCompletionNeedsAdmission(start: OrbitThreadStart): boolean {
  return (
    start.sentAt != null &&
    start.pendingThread === true &&
    start.completionOperationId == null &&
    start.completionKey != null &&
    !OPERATION_TERMINAL_STATUSES.has(start.completionStatus ?? "queued")
  );
}

/** The start after one read of its completion. */
export function applyOrbitCompletionRead(
  start: OrbitThreadStart,
  operation: OrbitGatewayOperation,
  now: number,
): OrbitThreadStart {
  const terminal = OPERATION_TERMINAL_STATUSES.has(operation.status);
  const failed = terminal && operation.status !== "succeeded";
  const next: OrbitThreadStart = {
    ...start,
    completionStatus: operation.status,
    completionErrorCode: failed
      ? (operation.errorCode ?? operation.error?.code ?? `operation.${operation.status}`)
      : null,
    completionErrorDetail: failed ? (operation.error?.detail ?? null) : null,
    completionProcessUnit: failed ? (operation.processFailureUnit ?? null) : null,
    completionRequires: failed ? (operation.recoveryRequires ?? null) : null,
    completionRetryable: failed && operation.recoveryRetryable === true,
  };
  // A completion a removal cancelled changes no row: the removal deletes the thread.
  if (orbitCompletionPhase(next) === "removed") return next;
  return {
    ...next,
    createRows: observeOrbitCompletionRows(start.createRows ?? null, operation, now),
  };
}

const isOrbitGatewayError = Schema.is(OrbitGatewayError);
/** The Gateway did not answer, or failed on its side. */
const isTransient = (error: unknown) =>
  isOrbitGatewayError(error) && (error.status === 0 || error.status >= 500);
/** An admission whose answer was lost on the way (as `runOrbitThreadStart` treats it). */
const isLostAdmission = (error: unknown) =>
  isOrbitGatewayError(error) &&
  (error.status === 0 ||
    ((error.status === 502 || error.status === 504) && error.code === "gateway.request_failed"));

/** How long reads may keep failing before a follow stops quietly, as for the create. */
const READ_OUTAGE_MS = 60_000;
/** Bounds one follow pass only; it never fails the card. */
const FOLLOW_PASS_MS = 30 * 60_000;
/** How long a Retry may keep losing its answer. */
const ADMISSION_MS = 5 * 60_000;

export interface OrbitCompletionPorts {
  readonly client: Pick<OrbitGatewayClient, "operation" | "completeInstance">;
  /** The saved start, read fresh: another window may have retried or dismissed it. */
  readonly read: () => OrbitThreadStart | null;
  readonly save: (start: OrbitThreadStart) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/**
 * Follows the saved completion to its end. It stops quietly, with the rows as saved, when the
 * start goes, a Retry replaced the Operation, the Gateway stays away for 60 s, or the read is
 * refused (an older Gateway answers 404 for this kind); the next runner pass tries again.
 */
export async function followOrbitCompletion(
  ports: OrbitCompletionPorts,
): Promise<"ended" | "stopped" | "lost"> {
  const operationId = ports.read()?.completionOperationId ?? null;
  if (operationId === null) return "stopped";
  const begin = ports.now();
  let outageSince: number | null = null;
  for (;;) {
    if (ports.read()?.completionOperationId !== operationId) return "stopped";
    let operation: OrbitGatewayOperation | null;
    try {
      operation = await ports.client.operation(operationId);
      outageSince = null;
    } catch (error) {
      outageSince ??= ports.now();
      if (!isTransient(error) || ports.now() - outageSince >= READ_OUTAGE_MS) return "lost";
      operation = null;
    }
    if (operation !== null) {
      const fresh = ports.read();
      if (fresh?.completionOperationId !== operationId) return "stopped";
      ports.save(applyOrbitCompletionRead(fresh, operation, ports.now()));
      if (OPERATION_TERMINAL_STATUSES.has(operation.status)) return "ended";
    }
    if (ports.now() - begin >= FOLLOW_PASS_MS) return "lost";
    await ports.sleep(operationPollDelayMs(operation?.pollAfterSeconds ?? null));
  }
}

/**
 * Retry of a failed completion, from any window: saves a new key with no Operation id, so no
 * follower reads the old one. Only the main window's runner sends it (`admitOrbitCompletion`),
 * so two windows never send one Retry twice. Conn never retries by itself.
 */
export function markOrbitCompletionRetry(
  ports: Pick<OrbitCompletionPorts, "read" | "save" | "now">,
): boolean {
  const start = ports.read();
  if (start === null || start.instanceId === null || orbitCompletionPhase(start) !== "failed") {
    return false;
  }
  ports.save({
    ...start,
    completionOperationId: null,
    completionKey: `conn-thread-start:${start.id}:complete:${ports.now()}`,
    completionStatus: "queued",
    completionErrorCode: null,
    completionErrorDetail: null,
    completionProcessUnit: null,
    completionRequires: null,
    completionRetryable: false,
    createRows: reopenOrbitCompletionRows(start.createRows ?? null),
  });
  return true;
}

/** Marks the Retry and sends it here: for a caller that is the only sender. */
export async function retryOrbitCompletion(ports: OrbitCompletionPorts): Promise<void> {
  if (markOrbitCompletionRetry(ports)) await admitOrbitCompletion(ports);
}

/**
 * Sends the saved Retry under its saved key until Orbit answers: a lost answer repeats it. A
 * refusal shows the failed card with its code; the rows that ran again fail again.
 */
export async function admitOrbitCompletion(ports: OrbitCompletionPorts): Promise<void> {
  const start = ports.read();
  if (start === null || start.instanceId === null || !start.completionKey) return;
  if (start.completionOperationId != null) return;
  const { instanceId, completionKey: key } = start;
  const begin = ports.now();
  let operation: OrbitGatewayOperation;
  for (let attempt = 0; ; attempt++) {
    try {
      operation = await ports.client.completeInstance(instanceId, key);
      break;
    } catch (error) {
      if (!isLostAdmission(error) || ports.now() - begin >= ADMISSION_MS) {
        const fresh = ports.read();
        if (fresh?.completionKey !== key || fresh.completionOperationId != null) return;
        ports.save({
          ...fresh,
          completionStatus: "failed",
          completionErrorCode: isOrbitGatewayError(error) ? error.code : null,
          completionErrorDetail: error instanceof Error ? error.message : String(error),
          completionRetryable: true,
          createRows: failRunningCompletionRows(fresh.createRows ?? null, ports.now()),
        });
        return;
      }
    }
    await ports.sleep(operationPollDelayMs(2 ** attempt));
  }
  const fresh = ports.read();
  if (fresh?.completionKey !== key || fresh.completionOperationId != null) return;
  ports.save(
    applyOrbitCompletionRead(
      { ...fresh, completionOperationId: operation.id },
      operation,
      ports.now(),
    ),
  );
}

/** A refused Retry fails the address row again, as a refused admission does. */
function failRunningCompletionRows(
  rows: OrbitCreateRows | null,
  now: number,
): OrbitCreateRows | null {
  const address = rows?.address;
  return rows == null || address?.status !== "running"
    ? (rows ?? null)
    : { ...rows, address: { ...address, status: "failed", finishedAt: now } };
}
