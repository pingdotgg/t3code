import {
  OPERATION_TERMINAL_STATUSES,
  type OrbitGatewayOperation,
  type OrbitGatewayOperationStep,
} from "./client.ts";

/**
 * Conn: the four rows under "Create Instance" while Orbit creates a clone. "container", "t3" and
 * "register" cover groups of the create Operation's steps and follow one after another. "address"
 * starts with the copy and runs until the address is live: the Route, the database copy, the
 * Processes and the checks, which today all run in the create's `instance.complete`.
 */
export const ORBIT_CREATE_ROW_IDS = ["container", "address", "t3", "register"] as const;
export type OrbitCreateRowId = (typeof ORBIT_CREATE_ROW_IDS)[number];
export type OrbitCreateRowStatus = "pending" | "running" | "done" | "failed";

export const ORBIT_CREATE_ROW_LABELS: Readonly<Record<OrbitCreateRowId, string>> = {
  container: "Copy the container",
  address: "Publish the address",
  t3: "Start the T3 server",
  register: "Register with Orbit",
};

/** What the saved start keeps per row; times are ms. */
export interface OrbitCreateRowState {
  readonly status: OrbitCreateRowStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}
export type OrbitCreateRows = Readonly<Partial<Record<OrbitCreateRowId, OrbitCreateRowState>>>;

/** The rows that run one after another; a later one running means the earlier ones ended. */
const SEQUENTIAL_ROWS = [
  "container",
  "t3",
  "register",
] as const satisfies readonly OrbitCreateRowId[];
type SequentialRowId = (typeof SEQUENTIAL_ROWS)[number];
const ROW_PHASE: Readonly<Record<SequentialRowId, number>> = { container: 0, t3: 1, register: 2 };
const isSequential = (id: OrbitCreateRowId): id is SequentialRowId => id !== "address";

const STEP_ROWS: Readonly<Record<string, OrbitCreateRowId>> = {
  input: "container",
  "clone-input": "container",
  "clone-container": "container",
  "clone-club-key": "container",
  csr: "address",
  sign: "address",
  // Orbit task group 5063 moves the Route publication into the create under these names.
  "clone-route-csr": "address",
  "clone-route": "address",
  site: "address",
  // The checkout runs beside the T3 start (create 20511).
  "clone-workspace": "t3",
  "clone-agent": "t3",
  "clone-t3": "t3",
  "clone-sessions": "register",
  "clone-session-copy": "register",
  "clone-register": "register",
  finish: "register",
  "clone-private-cleanup": "register",
  cleanup: "register",
  accepted: "register",
};

/**
 * The create's closing steps, which run after a failed step too (release 2061: finish, cleanup and
 * a failed `accepted` follow a failed clone-t3). They count for the register row only while no
 * other step failed, so a failure never also checks or fails "Register with Orbit".
 */
const CLOSING_STEPS: ReadonlySet<string> = new Set([
  "finish",
  "clone-private-cleanup",
  "cleanup",
  "accepted",
  "stop-container",
  "withdraw-route",
]);

/** Step name prefixes of the address row: numbered steps and Orbit's step descriptions. */
const ADDRESS_PREFIXES = [
  "clone-route-",
  "records-",
  "catalog-",
  "restart-",
  "Install cert",
  "Publish private DNS",
  "Probe the site",
];

function isRowId(value: unknown): value is OrbitCreateRowId {
  return typeof value === "string" && (ORBIT_CREATE_ROW_IDS as readonly string[]).includes(value);
}

/**
 * The row a create step belongs to: Orbit's `group` when it names a row, else the step name.
 * Null for a step Conn does not know.
 */
export function orbitCreateRowOf(step: {
  readonly name: string;
  readonly group?: string | null;
}): OrbitCreateRowId | null {
  if (isRowId(step.group)) return step.group;
  // Builds before the merge of the workspace row into the T3 row.
  if (step.group === "workspace") return "t3";
  if (Object.hasOwn(STEP_ROWS, step.name)) return STEP_ROWS[step.name]!;
  return ADDRESS_PREFIXES.some((prefix) => step.name.startsWith(prefix)) ? "address" : null;
}

/** A step's own status as a row status; null for skipped, legacy or unknown words, which count as nothing. */
function stepStatus(status: string): OrbitCreateRowStatus | null {
  switch (status) {
    case "pending":
    case "queued":
    case "waiting":
      return "pending";
    case "running":
    case "started":
      return "running";
    case "succeeded":
    case "completed":
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

interface RowRead {
  readonly status: OrbitCreateRowStatus;
  /** Orbit's own times over the row's steps, when it sent them. */
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

const time = (value: string | null): number | null => {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * What one read of the create Operation says about each row. A row the read says nothing about
 * is missing, so the saved state stays. A step Conn does not know counts for the row that ran
 * last before it, so it never moves the card back or blanks it.
 */
function readOrbitCreateRows(
  operation: OrbitGatewayOperation,
  previous: OrbitCreateRows | null = null,
): Partial<Record<OrbitCreateRowId, RowRead>> {
  const steps: readonly OrbitGatewayOperationStep[] = operation.steps ?? [];
  const running = runningRow(previous);
  // Where an unknown step belongs: the row that runs, else the one a Retry runs again (it
  // failed), else the copy when nothing ran yet. After a done row, nowhere: no done row reopens.
  const resumed = SEQUENTIAL_ROWS.findLast((id) => previous?.[id]?.status === "failed");
  const seen = SEQUENTIAL_ROWS.some((id) => previous?.[id] !== undefined);
  const unknownRow: SequentialRowId | null = running ?? resumed ?? (seen ? null : "container");
  const reads: Partial<Record<OrbitCreateRowId, RowRead>> = {};
  const terminal = OPERATION_TERMINAL_STATUSES.has(operation.status);
  /** A failed step that is neither a closing step nor a publication step (known or not). */
  const failedEarlier = (step: { readonly name: string }) =>
    !CLOSING_STEPS.has(step.name) && orbitCreateRowOf(step) !== "address";
  const failedSteps = steps.filter((step) => step.status === "failed");
  const named = operation.failedStep ?? null;
  // An address step Orbit names as the failure (Gateways before release 2061).
  const namedAddress = named !== null && orbitCreateRowOf({ name: named }) === "address";
  const broken = failedSteps.some(failedEarlier) || (named !== null && !CLOSING_STEPS.has(named));
  if (steps.length > 0) {
    const counted: Partial<Record<OrbitCreateRowId, OrbitGatewayOperationStep[]>> = {};
    const statuses = new Map<OrbitGatewayOperationStep, OrbitCreateRowStatus>();
    let last: OrbitCreateRowId | null = unknownRow;
    for (const step of steps) {
      const status = stepStatus(step.status);
      if (status === null) continue;
      if (broken && CLOSING_STEPS.has(step.name)) continue;
      const known = orbitCreateRowOf(step);
      const row: OrbitCreateRowId | null = known ?? (status === "pending" ? null : last);
      if (row === null) continue;
      if (status !== "pending" && isSequential(row)) last = row;
      // An unknown step that finished says nothing new; one that runs or failed holds its row.
      if (known === null && status === "done") continue;
      (counted[row] ??= []).push(step);
      statuses.set(step, status);
    }
    for (const id of ORBIT_CREATE_ROW_IDS) {
      const rowSteps = counted[id];
      if (!rowSteps) continue;
      const states = rowSteps.map((step) => statuses.get(step)!);
      const status: OrbitCreateRowStatus = states.includes("failed")
        ? "failed"
        : states.includes("running")
          ? "running"
          : states.every((state) => state === "done")
            ? "done"
            : states.includes("done")
              ? "running"
              : "pending";
      const starts = rowSteps.map((step) => time(step.startedAt)).filter((t) => t !== null);
      const ends = rowSteps.map((step) => time(step.finishedAt));
      reads[id] = {
        status,
        startedAt: starts.length > 0 ? Math.min(...starts) : null,
        finishedAt:
          status === "done" && ends.every((t) => t !== null)
            ? Math.max(...(ends as number[]))
            : null,
      };
    }
  } else if (operation.currentStep) {
    // Orbit's Conn show may send only the current step: earlier phases have ended.
    const row = orbitCreateRowOf({ name: operation.currentStep }) ?? unknownRow;
    if (row !== null && isSequential(row)) {
      for (const id of SEQUENTIAL_ROWS) {
        if (ROW_PHASE[id] < ROW_PHASE[row]) {
          reads[id] = { status: "done", startedAt: null, finishedAt: null };
        }
      }
    }
    if (row !== null) reads[row] = { status: "running", startedAt: null, finishedAt: null };
  }
  // The address starts with the copy and runs while the create runs, whatever its own steps say:
  // its row ends only with the completion (or with a create that has none). A failed publication
  // step fails nothing: it never fails the create, and the completion publishes again.
  const begun = ORBIT_CREATE_ROW_IDS.some(
    (id) => reads[id] !== undefined && reads[id]!.status !== "pending",
  );
  if (!terminal) {
    if (begun || previous?.address?.status === "running") {
      reads.address = { startedAt: null, finishedAt: null, ...reads.address, status: "running" };
    }
  }
  // Orbit names the create step that failed it. Without that name: a failed step of the copy,
  // T3 or register phases, then a closing step. A failed publication step never names the
  // failure: the row that ran takes it, and the address only when no row ran.
  const failedName =
    named ??
    (failedSteps.find(failedEarlier) ?? failedSteps.find((step) => CLOSING_STEPS.has(step.name)))
      ?.name ??
    null;
  const addressFailedAtEnd =
    terminal && failedSteps.some((step) => orbitCreateRowOf(step) === "address");
  let failedRow: OrbitCreateRowId | null = null;
  if (operation.status === "succeeded") {
    const completes = typeof operation.completionOperationId === "number";
    for (const id of ORBIT_CREATE_ROW_IDS) {
      reads[id] =
        id === "address" && completes
          ? { startedAt: reads[id]?.startedAt ?? null, finishedAt: null, status: "running" }
          : { startedAt: null, finishedAt: null, ...reads[id], status: "done" };
    }
  } else if (
    (failedName !== null || terminal) &&
    !SEQUENTIAL_ROWS.some((id) => reads[id]?.status === "failed")
  ) {
    const failedStep = failedName === null ? null : steps.find((step) => step.name === failedName);
    const row =
      (failedName === null ? null : orbitCreateRowOf(failedStep ?? { name: failedName })) ??
      SEQUENTIAL_ROWS.findLast((id) => reads[id]?.status === "running") ??
      running ??
      (failedName !== null ? "container" : addressFailedAtEnd ? "address" : null);
    if (row) reads[row] = { startedAt: null, finishedAt: null, ...reads[row], status: "failed" };
    failedRow = row;
  }
  // A create that ended without success: the address row follows Orbit's route_publication,
  // unless the failure is an address step (Gateways before release 2061).
  if (terminal && operation.status !== "succeeded" && (failedRow === "address" || namedAddress)) {
    reads.address = { startedAt: null, finishedAt: null, ...reads.address, status: "failed" };
  } else if (terminal && operation.status !== "succeeded") {
    reads.address = {
      startedAt: null,
      finishedAt: null,
      status: orbitFailedCreateAddressStatus({
        createStatus: operation.status,
        routePublication: orbitRoutePublication(operation),
        completionStatus: null,
      }),
    };
  }
  return reads;
}

/** The one switch for Nick's answer on a failed create whose address Orbit published. */
const PUBLISHED_AFTER_FAILED_CREATE: OrbitCreateRowStatus = "done";

/**
 * The address row of a create that failed or was cancelled, from its `route_publication`:
 * "published" stays live (502) until a Retry or a removal; "failed" is the X; absent or
 * "deferred" did not start.
 */
export function orbitFailedCreateAddressStatus(input: {
  readonly createStatus: string;
  readonly routePublication: string | null;
  readonly completionStatus: string | null;
}): OrbitCreateRowStatus {
  switch (input.routePublication) {
    case "published":
      // Waits on Nick (proposal 2026-11-14): "done" shows the check; "pending" shows the ring.
      return PUBLISHED_AFTER_FAILED_CREATE;
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/** `result.route_publication` of a create (Orbit task group 5063), or null. */
function orbitRoutePublication(operation: OrbitGatewayOperation | null): string | null {
  const value = operation?.result?.route_publication;
  return typeof value === "string" ? value : null;
}

function runningRow(rows: OrbitCreateRows | null): SequentialRowId | null {
  return SEQUENTIAL_ROWS.findLast((id) => rows?.[id]?.status === "running") ?? null;
}

/**
 * The rows after a read of the create Operation. While it runs, Orbit's step times may be null,
 * so a row counts from when Conn first saw it run (or end); once the Operation ended, Orbit's
 * exact times replace Conn's wherever Orbit sent them. Rows never go back to pending.
 */
export function observeOrbitCreateRows(
  previous: OrbitCreateRows | null,
  operation: OrbitGatewayOperation,
  now: number,
): OrbitCreateRows {
  const reads = readOrbitCreateRows(operation, previous);
  const terminal = OPERATION_TERMINAL_STATUSES.has(operation.status);
  const next: Partial<Record<OrbitCreateRowId, OrbitCreateRowState>> = { ...previous };
  for (const id of ORBIT_CREATE_ROW_IDS) {
    const before = previous?.[id] ?? null;
    const read = reads[id];
    let state: OrbitCreateRowState | null = before;
    if (read && read.status !== "pending") {
      const startedAt = before?.startedAt ?? now;
      state = {
        status: read.status,
        startedAt,
        finishedAt: read.status === "running" ? null : (before?.finishedAt ?? now),
      };
    } else if (id === "address" && read?.status === "pending" && terminal) {
      // A failed create whose address did not start (orbitFailedCreateAddressStatus).
      state = { status: "pending", startedAt: before?.startedAt ?? null, finishedAt: null };
    } else if (terminal && before?.status === "running") {
      // The Operation ended without a word on this row.
      state = {
        ...before,
        status: operation.status === "succeeded" ? "done" : "failed",
        finishedAt: now,
      };
    }
    if (state !== null && terminal && read) {
      state = {
        ...state,
        startedAt: read.startedAt ?? state.startedAt,
        finishedAt: read.finishedAt ?? state.finishedAt,
      };
    }
    if (state !== null) next[id] = state;
  }
  return next;
}

/**
 * The rows after a create failed where Orbit named no step: the row that ran failed now, and the
 * address row follows `orbitFailedCreateAddressStatus`.
 */
export function stopRunningOrbitCreateRows(
  rows: OrbitCreateRows | null,
  now: number,
): OrbitCreateRows | null {
  const id = SEQUENTIAL_ROWS.findLast((row) => rows?.[row]?.status === "running");
  if (
    rows === null ||
    id === undefined ||
    SEQUENTIAL_ROWS.some((row) => rows[row]?.status === "failed")
  ) {
    return null;
  }
  const address = rows.address;
  return {
    ...rows,
    [id]: { ...rows[id]!, status: "failed", finishedAt: now },
    ...(address?.status === "running"
      ? {
          address: {
            ...address,
            // No terminal read on this path, so no route_publication either.
            status: orbitFailedCreateAddressStatus({
              createStatus: "failed",
              routePublication: null,
              completionStatus: null,
            }),
            finishedAt: null,
          },
        }
      : {}),
  };
}

/** Saved rows from a stored start of any build; a broken row reads as missing. */
export function readSavedOrbitCreateRows(value: unknown): OrbitCreateRows | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rows: Partial<Record<OrbitCreateRowId, OrbitCreateRowState>> = {};
  for (const id of ORBIT_CREATE_ROW_IDS) {
    const row = (value as Record<string, unknown>)[id];
    if (typeof row !== "object" || row === null) continue;
    const { status, startedAt, finishedAt } = row as Record<string, unknown>;
    if (status !== "pending" && status !== "running" && status !== "done" && status !== "failed") {
      continue;
    }
    rows[id] = {
      status,
      startedAt: typeof startedAt === "number" ? startedAt : null,
      finishedAt: typeof finishedAt === "number" ? finishedAt : null,
    };
  }
  return rows;
}

/** Whether two saved row sets are the same, so a read that changed nothing saves nothing. */
export function sameOrbitCreateRows(
  left: OrbitCreateRows | null | undefined,
  right: OrbitCreateRows | null | undefined,
): boolean {
  return ORBIT_CREATE_ROW_IDS.every((id) => {
    const a = left?.[id];
    const b = right?.[id];
    return (
      a?.status === b?.status && a?.startedAt === b?.startedAt && a?.finishedAt === b?.finishedAt
    );
  });
}

/**
 * The address row after a read of `instance.complete`, whose every step (known or not) is this
 * row. It runs until the completion ends: done when it succeeded, failed otherwise. The other
 * rows ended with the create and never reopen.
 */
export function observeOrbitCompletionRows(
  previous: OrbitCreateRows | null,
  operation: OrbitGatewayOperation,
  now: number,
): OrbitCreateRows {
  const before = previous?.address ?? null;
  const steps = (operation.steps ?? []).filter((step) => stepStatus(step.status) !== null);
  const starts = steps.map((step) => time(step.startedAt)).filter((t) => t !== null);
  const ends = steps.map((step) => time(step.finishedAt)).filter((t) => t !== null);
  const lastEnd = ends.length > 0 ? Math.max(...ends) : null;
  // A failed step while the Operation runs fails nothing yet: Orbit may carry on.
  const status: OrbitCreateRowStatus =
    operation.status === "succeeded"
      ? "done"
      : OPERATION_TERMINAL_STATUSES.has(operation.status)
        ? "failed"
        : "running";
  return {
    ...previous,
    address: {
      status,
      startedAt: before?.startedAt ?? (starts.length > 0 ? Math.min(...starts) : now),
      finishedAt: status === "running" ? null : (lastEnd ?? before?.finishedAt ?? now),
    },
  };
}

/** A Retry of the completion: the address row runs again, the other rows stay as they are. */
export function reopenOrbitCompletionRows(rows: OrbitCreateRows | null): OrbitCreateRows | null {
  if (rows === null) return null;
  const address = rows.address;
  return address?.status === "failed"
    ? { ...rows, address: { ...address, status: "running", finishedAt: null } }
    : rows;
}
