import * as DateTime from "effect/DateTime";

import type {
  OrchestrationV2Run,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
} from "../orchestrationV2.ts";

/**
 * waiting: no live or finished turn holds it, so the next turn or tool call takes it.
 * sent: the input of a run that has not ended holds it.
 * delivered: the run that holds it ended completed.
 */
export type FyiDeliveryState = "waiting" | "sent" | "delivered";

/** Run outcomes that give a carried FYI back: the model may not have read it. */
export const FYI_RETURNING_RUN_STATUSES = [
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
] as const satisfies ReadonlyArray<OrchestrationV2RunStatus>;

const returning: ReadonlySet<OrchestrationV2RunStatus> = new Set(FYI_RETURNING_RUN_STATUSES);

type FyiCarrierFields = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>,
  "runId" | "nodeId"
>;

/**
 * The one rule. An FYI's carrier is the run in `item.runId` while `item.nodeId` is still its root
 * node: a steering restart gives the run a new root node. Only a carrier that ended completed shows
 * that the model got it. `run` is the run whose id is `item.runId`, or undefined when the reader
 * lacks it. The SQL mirror is FYI_WAITING_SQL in apps/server/src/fork/fyi/Fyi.ts.
 */
export function fyiDeliveryState(
  item: FyiCarrierFields,
  run: Pick<OrchestrationV2Run, "status" | "rootNodeId"> | undefined,
): FyiDeliveryState {
  if (item.runId === null || item.nodeId === null || run?.rootNodeId !== item.nodeId) {
    return "waiting";
  }
  if (returning.has(run.status)) return "waiting";
  return run.status === "completed" ? "delivered" : "sent";
}

/**
 * The state a reader that may lack the carrier run can show. Clients load only some runs, and a
 * fork shows its source's items, so a bound FYI without its run claims no state.
 */
export function fyiShownState(
  item: FyiCarrierFields,
  run: Pick<OrchestrationV2Run, "status" | "rootNodeId"> | undefined,
): FyiDeliveryState | "unknown" {
  return item.runId !== null && run === undefined ? "unknown" : fyiDeliveryState(item, run);
}

/** An FYI longer than one turn's FYI budget could fail every turn that sends it again. */
export const FYI_TEXT_MAX_CHARS = 16_000;

/** When an FYI message was sent: its item is written then and keeps it through every move. */
export const fyiSentAt = (item: {
  readonly startedAt: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc;
}): DateTime.Utc => item.startedAt ?? item.updatedAt;

const escapeAttribute = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The text stays as sent, code included; only a tag that could open or close an element changes. */
const neutralizeFyiTags = (text: string) => text.replace(/<(?=\/?fyi\b)/gi, "&lt;");

/** How an agent reads one FYI message, at turn start, at a tool call, and in handed-off history. */
export function fyiElement(item: {
  readonly text: string;
  readonly senderThreadId?: string | undefined;
  readonly linkedSender?: { readonly threadId: string; readonly title: string } | undefined;
  readonly startedAt: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc;
}): string {
  const from =
    item.linkedSender !== undefined
      ? `${item.linkedSender.title} (thread ${item.linkedSender.threadId}, linked environment)`
      : item.senderThreadId !== undefined
        ? `thread ${item.senderThreadId}`
        : undefined;
  const fromAttribute = from === undefined ? "" : ` from="${escapeAttribute(from)}"`;
  return `<fyi${fromAttribute} sent="${DateTime.formatIso(fyiSentAt(item))}">\n${neutralizeFyiTags(item.text)}\n</fyi>`;
}
