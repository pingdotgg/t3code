import type { OrbitGatewayOperation } from "./client.ts";
import {
  ORBIT_CREATE_ROW_IDS,
  ORBIT_CREATE_ROW_LABELS,
  orbitFailedCreateAddressStatus,
  type OrbitCreateRowId,
  type OrbitCreateRowStatus,
} from "./orbitCreateRows.ts";
import { orbitCompletionPhase } from "./orbitCompletion.ts";
import type { OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: the setup stages of a thread started in an Orbit Project, for the setup card shown before
 * the clone's server exists.
 */
export type OrbitSetupStageId = "create" | "connect" | "agent";
export type OrbitSetupStageStatus = "pending" | "running" | "done" | "failed";

export interface OrbitSetupStage {
  readonly id: OrbitSetupStageId;
  readonly status: OrbitSetupStageStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** "create": the Node the clone lands on. */
  readonly detail: string | null;
  /** "create": the rows of Orbit's create steps while it runs or where it failed; else null. */
  readonly rows: readonly OrbitSetupCreateRow[] | null;
  /** Set on the failed stage only. */
  readonly error: string | null;
  readonly errorCode: string | null;
}

export interface OrbitSetupCreateRow {
  readonly id: OrbitCreateRowId;
  readonly label: string;
  readonly status: OrbitCreateRowStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * The rows under "Create Instance": all four while the setup runs or failed, also after the create
 * while its completion runs or failed (the address row follows it), and on a create refused before
 * Orbit admitted it (all pending). They fold away once the setup is done.
 */
function createRows(start: OrbitThreadStart): OrbitSetupCreateRow[] {
  const saved = start.createRows ?? null;
  // With a completion the address row is its phase, whatever an older build saved.
  const completion = orbitCompletionPhase(start);
  const addressOfCompletion: OrbitCreateRowStatus | null =
    completion === "running" ? "running" : completion === "failed" ? "failed" : null;
  const createFailed = start.error !== null && start.environmentId === null;
  const failedHere =
    createFailed && !ORBIT_CREATE_ROW_IDS.some((id) => saved?.[id]?.status === "failed");
  // A failure the Operation never named (a timeout, a lost Gateway) stops the row that ran.
  const stopped = failedHere
    ? (["container", "t3", "register"] as const).findLast((id) => saved?.[id]?.status === "running")
    : undefined;
  return ORBIT_CREATE_ROW_IDS.map((id) => {
    const row = saved?.[id];
    const status: OrbitCreateRowStatus =
      id === stopped
        ? "failed"
        : id === "address" && addressOfCompletion !== null
          ? addressOfCompletion
          : // The unnamed failure that stopped a row: no terminal read, so no route_publication.
            id === "address" && stopped !== undefined && row?.status === "running"
            ? orbitFailedCreateAddressStatus({
                createStatus: "failed",
                routePublication: null,
                completionStatus: null,
              })
            : (row?.status ?? "pending");
    return {
      id,
      label: ORBIT_CREATE_ROW_LABELS[id],
      status,
      startedAt: row?.startedAt ?? null,
      finishedAt: id === stopped ? (start.createFinishedAt ?? null) : (row?.finishedAt ?? null),
    };
  });
}

/**
 * The stages of a start: Create Instance, Connect, Start agent; a start in an existing Instance
 * has only Connect and Start agent. The pairing state comes from the start record. `create` is the
 * latest read of the create Operation, when there is one.
 */
export function orbitSetupStages(input: {
  readonly start: OrbitThreadStart;
  readonly create?: OrbitGatewayOperation | null;
}): OrbitSetupStage[] {
  const { start } = input;
  const create = input.create ?? null;
  // Only the saved start fails a stage: a Retry clears its error while an old read still shows
  // the failed Operation.
  const failedAt: OrbitSetupStageId | null =
    start.error === null
      ? null
      : start.environmentId === null
        ? "create"
        : start.connected
          ? "agent"
          : "connect";
  const errorCode = start.errorCode ?? create?.errorCode ?? create?.error?.code ?? null;
  const stage = (
    id: OrbitSetupStageId,
    status: OrbitSetupStageStatus,
    startedAt: number | null | undefined,
    finishedAt: number | null | undefined,
    detail: string | null = null,
    rows: readonly OrbitSetupCreateRow[] | null = null,
  ): OrbitSetupStage => ({
    id,
    status: failedAt === id ? "failed" : status,
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    detail,
    rows,
    error: failedAt === id ? start.error : null,
    errorCode: failedAt === id ? errorCode : null,
  });

  const stages: OrbitSetupStage[] = [];
  if (start.orbitInstanceKind !== "existing") {
    const completion = orbitCompletionPhase(start);
    // A succeeded create read whose completion the runner has not saved yet.
    const completionAhead =
      completion === "none" && typeof create?.completionOperationId === "number";
    // The header spins until the address is live, and shows the card's failure wherever it is.
    const status: OrbitSetupStageStatus =
      start.error !== null || completion === "failed"
        ? "failed"
        : start.environmentId !== null || create?.status === "succeeded"
          ? completion === "running" || completionAhead
            ? "running"
            : "done"
          : start.createStartedAt != null || start.createOperationId !== null || create !== null
            ? "running"
            : "pending";
    stages.push(
      stage(
        "create",
        status,
        start.createStartedAt,
        start.createFinishedAt,
        start.nodeName,
        status === "done" ? null : createRows(start),
      ),
    );
  }
  stages.push(
    stage(
      "connect",
      start.connected
        ? "done"
        : // Runs once the runner stamped it: after a Retry it waits until the runner gets there.
          start.environmentId !== null && start.connectStartedAt != null
          ? "running"
          : "pending",
      start.connectStartedAt,
      start.connectFinishedAt,
    ),
    stage(
      "agent",
      start.sentAt != null ? "done" : start.connected ? "running" : "pending",
      start.agentStartedAt,
      start.sentAt,
    ),
  );
  return stages;
}
