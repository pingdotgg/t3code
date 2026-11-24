import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { isSlashCommandMessage } from "./ContextHandoffDelivery.ts";

const DELIVERED_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "running",
  "waiting",
  "completed",
  "interrupted",
]);

/**
 * Whether the provider conversation already holds the agent's instructions, so this turn can skip
 * them. Only the turn just before on the same provider thread counts: a new provider thread, a
 * fresh context, a compaction, or another agent in between sends them again.
 */
export function agentAlreadyInstructed(
  projection: {
    readonly runs: ReadonlyArray<
      Pick<
        OrchestrationV2Run,
        "ordinal" | "startedAt" | "providerThreadId" | "status" | "userMessageId"
      >
    >;
    readonly messages: ReadonlyArray<
      Pick<OrchestrationV2ThreadProjection["messages"][number], "id" | "role" | "text" | "context">
    >;
  },
  run: Pick<OrchestrationV2Run, "ordinal" | "providerThreadId" | "freshContext">,
  agent: string,
): boolean {
  if (run.freshContext === true) return false;
  const previous = projection.runs.findLast(
    (source) =>
      source.ordinal < run.ordinal &&
      source.startedAt !== null &&
      source.providerThreadId === run.providerThreadId,
  );
  if (previous === undefined || !DELIVERED_STATUSES.has(previous.status)) return false;
  const message = projection.messages.find((source) => source.id === previous.userMessageId);
  return (
    message !== undefined && message.context?.agent === agent && !isSlashCommandMessage(message)
  );
}
