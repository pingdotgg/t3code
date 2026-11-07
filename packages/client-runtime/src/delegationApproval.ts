import type {
  DelegationApprovalAnswerInput,
  ModelSelection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export type DelegationApprovalItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "delegation_approval" }
>;

export type DelegationApprovalDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "approved" | "declined" | "ended";
      readonly label: string;
    };

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function delegationApprovalDisplay(
  item: Pick<DelegationApprovalItem, "approvalStatus">,
  visibility: "local" | "inherited" | "synthetic",
): DelegationApprovalDisplay {
  switch (item.approvalStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: "Waiting for an answer in the original thread" };
    case "approved":
      return { kind: "answered", outcome: "approved", label: "Approved" };
    case "declined":
      return { kind: "answered", outcome: "declined", label: "Declined" };
    case "cancelled":
      return { kind: "answered", outcome: "ended", label: "Request ended" };
  }
}

/** One line per selection, such as `codex · gpt-5.4 · reasoningEffort high`. */
export function delegationSelectionLabel(selection: ModelSelection): string {
  return [
    selection.instanceId,
    selection.model,
    ...(selection.options ?? []).map((option) => `${option.id} ${String(option.value)}`),
  ].join(" · ");
}

export function delegationApprovalAnswerInput(
  item: Pick<DelegationApprovalItem, "id" | "threadId">,
  decision: DelegationApprovalAnswerInput["decision"],
): DelegationApprovalAnswerInput {
  return { threadId: item.threadId, turnItemId: item.id, decision };
}

const USER_FACING_FAILURE_TAGS = new Set([
  "DelegationApprovalError",
  "EnvironmentAuthorizationError",
]);

/** Only known server errors pass their message through; anything else gets generic copy. */
export function delegationApprovalFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
