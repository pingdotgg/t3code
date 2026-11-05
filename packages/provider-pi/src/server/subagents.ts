import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import {
  piRecordField as field,
  piRecordNumber as number,
  piRecordString as text,
  type PiRpcRecord,
} from "./rpc.ts";

export function piSubagentStatus(
  state: string | undefined,
): OrchestrationV2Subagent["status"] | undefined {
  switch (state) {
    case "pending":
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "complete":
    case "completed":
      return "completed";
    case "failed":
    case "partial":
    case "rejected":
      return "failed";
    case "detached":
    case "paused":
      return "idle";
    case "stopped":
      return "interrupted";
    default:
      return undefined;
  }
}

export interface PiSubagentSnapshotNode {
  readonly id: string;
  readonly kind: "subagent" | "workflow" | "step";
  readonly title: string;
  readonly model: string | undefined;
  readonly status: OrchestrationV2Subagent["status"];
  readonly progress: string | undefined;
  readonly startedAt: number | undefined;
  readonly children: ReadonlyArray<PiSubagentSnapshotNode>;
}

const snapshotPrefix = "PI_SUBAGENT_ASYNC_JSON:";
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("pi-subagents.async-status-snapshot"),
      version: Schema.Literal(1),
      runs: Schema.Array(Schema.Unknown),
    }),
  ),
);

/** The versioned RPC widget is structured state, independent of its display text. */
export function readPiSubagentSnapshot(
  event: PiRpcRecord,
): ReadonlyArray<PiSubagentSnapshotNode> | undefined {
  if (
    event["type"] !== "extension_ui_request" ||
    event["method"] !== "setWidget" ||
    event["widgetKey"] !== "subagent-async"
  )
    return undefined;
  const lines = event["widgetLines"];
  if (!Array.isArray(lines)) return undefined;
  const line = lines.find(
    (line): line is string => typeof line === "string" && line.startsWith(snapshotPrefix),
  );
  if (line === undefined || line.length > 64 * 1024) return undefined;
  const decoded = decodeSnapshot(line.slice(snapshotPrefix.length));
  if (Option.isNone(decoded)) return undefined;
  let remaining = 200;
  const visit = (node: unknown, depth: number): PiSubagentSnapshotNode[] => {
    if (depth > 4 || remaining-- <= 0) return [];
    const kind = text(node, "kind");
    const id = text(node, "id");
    const title = text(node, "agent") ?? text(node, "label");
    const status = piSubagentStatus(text(node, "state"));
    if (
      (kind !== "subagent" && kind !== "workflow" && kind !== "step") ||
      !id ||
      id.length > 160 ||
      title === undefined ||
      status === undefined
    )
      return [];
    const activity = field(node, "activity");
    const children = field(node, "children");
    const startedAt = number(node, "startedAt");
    return [
      {
        id,
        kind,
        title: title.slice(0, 160),
        model: text(node, "model")?.slice(0, 160),
        status,
        progress: (text(activity, "currentTool") ?? text(activity, "state"))?.slice(0, 200),
        startedAt:
          startedAt !== undefined && startedAt >= 0 && startedAt <= 8.64e15 ? startedAt : undefined,
        children: Array.isArray(children)
          ? children.slice(0, 8).flatMap((child) => visit(child, depth + 1))
          : [],
      },
    ];
  };
  return decoded.value.runs.slice(0, 20).flatMap((run) => visit(run, 0));
}
