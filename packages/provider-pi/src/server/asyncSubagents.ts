import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
} from "./rpc.ts";

/** pi-subagents publishes background run status to RPC hosts through this widget key. */
export const PI_SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async";
const SNAPSHOT_LINE_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";

export type PiAsyncSubagentStatus = OrchestrationV2Subagent["status"];

export interface PiAsyncSubagentStep {
  readonly id: string;
  readonly title: string;
  readonly label: string;
  readonly status: PiAsyncSubagentStatus;
  readonly model: string | null;
  readonly currentTool: string | undefined;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
}

export interface PiAsyncSubagentRun {
  readonly id: string;
  readonly status: PiAsyncSubagentStatus;
  readonly steps: ReadonlyArray<PiAsyncSubagentStep>;
}

export function isSettledPiAsyncSubagentStatus(status: PiAsyncSubagentStatus): boolean {
  return status !== "pending" && status !== "running" && status !== "waiting";
}

function snapshotStatus(state: string | undefined): PiAsyncSubagentStatus | undefined {
  switch (state) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "complete":
      return "completed";
    case "stopped":
      return "interrupted";
    case "failed":
    case "partial":
    case "rejected":
      return "failed";
    default:
      return undefined;
  }
}

function snapshotStep(
  node: unknown,
  runStatus: PiAsyncSubagentStatus,
): PiAsyncSubagentStep | undefined {
  if (recordString(node, "kind") !== "step") return undefined;
  const id = recordString(node, "id");
  const ownStatus = snapshotStatus(recordString(node, "state"));
  if (id === undefined || ownStatus === undefined) return undefined;
  const label = recordString(node, "label") ?? id;
  // A lane that never ran in a stopped or failed run ends with the run.
  const status =
    isSettledPiAsyncSubagentStatus(runStatus) && !isSettledPiAsyncSubagentStatus(ownStatus)
      ? runStatus
      : ownStatus;
  return {
    id,
    title: recordString(node, "agent") ?? label,
    label,
    status,
    model: recordString(node, "model") ?? null,
    currentTool: recordString(recordField(node, "activity"), "currentTool"),
    startedAt: recordNumber(node, "startedAt"),
    endedAt: recordNumber(node, "endedAt"),
  };
}

function snapshotRun(node: unknown): PiAsyncSubagentRun | undefined {
  const id = recordString(node, "id");
  const status = snapshotStatus(recordString(node, "state"));
  if (id === undefined || status === undefined) return undefined;
  const children = recordField(node, "children");
  const steps = Array.isArray(children)
    ? children.flatMap((child) => {
        const step = snapshotStep(child, status);
        return step === undefined ? [] : [step];
      })
    : [];
  return { id, status, steps };
}

/**
 * Reads the runs pi-subagents reports on its async widget. A cleared widget means no runs are
 * tracked; lines that are not a status snapshot return undefined so the host leaves its state alone.
 */
export function parsePiAsyncSubagentSnapshot(
  widgetLines: unknown,
): ReadonlyArray<PiAsyncSubagentRun> | undefined {
  if (widgetLines === undefined || widgetLines === null) return [];
  if (!Array.isArray(widgetLines)) return undefined;
  const line = widgetLines.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.startsWith(SNAPSHOT_LINE_PREFIX),
  );
  if (line === undefined) return undefined;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(line.slice(SNAPSHOT_LINE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (recordString(snapshot, "kind") !== SNAPSHOT_KIND) return undefined;
  const runs = recordField(snapshot, "runs");
  if (!Array.isArray(runs)) return undefined;
  return runs.flatMap((node) => {
    const run = snapshotRun(node);
    return run === undefined ? [] : [run];
  });
}
