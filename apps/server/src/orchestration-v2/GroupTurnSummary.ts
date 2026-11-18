import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

import { isSnoozed } from "./ThreadSettlementService.ts";

export type GroupSummaryState = "working" | "needs input" | "done" | "failed" | "stopped" | "idle";

export interface GroupSummaryMember {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly state: GroupSummaryState;
  readonly settled: boolean;
  readonly snoozed: boolean;
}

const NEEDS_INPUT_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
  "user_input",
]);

export function groupSummaryMemberState(
  thread: Pick<OrchestrationV2ThreadShell, "status" | "pendingRuntimeRequest">,
): GroupSummaryState {
  if (
    thread.pendingRuntimeRequest !== null &&
    NEEDS_INPUT_REQUEST_KINDS.has(thread.pendingRuntimeRequest.kind)
  ) {
    return "needs input";
  }
  switch (thread.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
      return "working";
    case "waiting":
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    case "idle":
      return "idle";
  }
}

export function groupSummaryMember(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "title"
    | "status"
    | "pendingRuntimeRequest"
    | "settledOverride"
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): GroupSummaryMember {
  return {
    threadId: thread.id,
    title: thread.title,
    state: groupSummaryMemberState(thread),
    settled: thread.settledOverride === "settled",
    snoozed: isSnoozed(thread, nowMs),
  };
}

export interface GroupBoardChange {
  readonly topicId: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly editorTitle: string;
}

export function groupTurnSummary(input: {
  readonly self: ThreadId;
  readonly lead: GroupSummaryMember;
  readonly workers: ReadonlyArray<GroupSummaryMember>;
  readonly boardChanges: ReadonlyArray<GroupBoardChange>;
}): { readonly text: string; readonly fingerprint: string } {
  const { self, lead, workers, boardChanges } = input;
  const line = (member: GroupSummaryMember, marks: ReadonlyArray<string>) => {
    const label = marks.length === 0 ? "" : ` (${marks.join(", ")})`;
    const flags = [member.settled ? ", settled" : "", member.snoozed ? ", snoozed" : ""].join("");
    return `- ${member.title}${label}: ${member.state}${flags}`;
  };
  const you = (member: GroupSummaryMember) => (member.threadId === self ? ["you"] : []);
  const text = [
    `T3 group "${lead.title}" (you are ${lead.threadId === self ? "the lead" : "a worker"}):`,
    line(lead, ["lead", ...you(lead)]),
    ...workers.map((worker) => line(worker, you(worker))),
    ...(boardChanges.length === 0
      ? []
      : [
          `Board updates: ${boardChanges
            .map((change) => `"${change.title}" by ${change.editorTitle}`)
            .join("; ")}`,
          "Read the board with t3_thread_board.",
        ]),
    "Messages between group members are queued until the receiver's turn ends; read details with t3_thread_read.",
  ].join("\n");
  const fingerprint = JSON.stringify([
    self,
    ...[lead, ...workers].map((member) => [
      member.threadId,
      member.title,
      member.state,
      member.settled,
      member.snoozed,
    ]),
    ...boardChanges.map((change) => [change.topicId, change.updatedAt]),
  ]);
  return { text, fingerprint };
}
