import {
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  ProviderApprovalOption,
  ProviderRequestKind,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
}

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

const isRequestId = Schema.is(ApprovalRequestId);
const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);
const QuestionOption = Schema.Struct({
  ...UserInputQuestion.fields.options.value.fields,
  label: Schema.String,
});
const isQuestionOption = Schema.is(QuestionOption);
// Native question IDs and option labels can be answer keys. Do not trim them.
const decodeQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    ...UserInputQuestion.fields,
    id: Schema.String,
    header: Schema.String,
    question: Schema.String,
    options: Schema.Array(QuestionOption),
  }),
);

/** Older activities use native request types instead of a request kind. */
export function requestKindFromRequestType(requestType: unknown): ProviderRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    default:
      return null;
  }
}

function parseQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    if (!Predicate.isObject(question) || !Array.isArray(question.options)) return [];
    const options = question.options.filter(isQuestionOption);
    if (options.length === 0 && question.allowCustomAnswer === false) return [];
    const parsed = decodeQuestion({
      id: question.id,
      header: question.header,
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
      ...(typeof question.allowCustomAnswer === "boolean"
        ? { allowCustomAnswer: question.allowCustomAnswer }
        : {}),
    });
    return Option.isSome(parsed) ? [parsed.value] : [];
  });
}

const requestActivityKinds = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

// The server reports a stale or unknown request through the failure text.
// A failed reply with any other text stays open so the user can retry.
const staleRequestFailureDetails = {
  "provider.approval.respond.failed": [
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "unknown pending codex approval request",
  ],
  "provider.user-input.respond.failed": [
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ],
} as const;

function isStaleRequestFailure(
  kind: keyof typeof staleRequestFailureDetails,
  payload: Record<string, unknown>,
): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return staleRequestFailureDetails[kind].some((fragment) => detail.includes(fragment));
}

/** Reduces request state once for web, desktop, and mobile. Layout stays with each client. */
export function derivePendingRequests(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const approvals = new Map<ApprovalRequestId, PendingApproval>();
  const userInputs = new Map<ApprovalRequestId, PendingUserInput>();
  const closedApprovals = new Set<ApprovalRequestId>();
  const closedUserInputs = new Set<ApprovalRequestId>();

  // Request IDs are unique. A terminal event stays final even when provider
  // sequences and server-generated activities arrive in a different order.
  for (const activity of activities) {
    if (!requestActivityKinds.has(activity.kind)) continue;
    const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
    if (!payload || !isRequestId(payload.requestId)) continue;
    const requestId = payload.requestId;

    if (activity.kind === "approval.requested") {
      if (
        closedApprovals.has(requestId) ||
        payload.requestType === "tool_user_input" ||
        payload.requestType === "auth_tokens_refresh"
      ) {
        continue;
      }
      const requestKind = isProviderRequestKind(payload.requestKind)
        ? payload.requestKind
        : requestKindFromRequestType(payload.requestType);
      const options = Array.isArray(payload.options)
        ? payload.options.filter(isProviderApprovalOption)
        : [];
      approvals.set(requestId, {
        requestId,
        // Older OpenCode approvals do not always include a recognized kind.
        requestKind: requestKind ?? "command",
        createdAt: activity.createdAt,
        ...(typeof payload.detail === "string" && payload.detail ? { detail: payload.detail } : {}),
        ...(typeof payload.appName === "string" && payload.appName
          ? { appName: payload.appName }
          : {}),
        ...(options.length > 0 ? { options } : {}),
      });
    } else if (activity.kind === "user-input.requested") {
      if (closedUserInputs.has(requestId)) continue;
      const questions = parseQuestions(payload.questions);
      if (questions.length === 0) continue;
      userInputs.set(requestId, { requestId, createdAt: activity.createdAt, questions });
    } else if (
      activity.kind === "approval.resolved" ||
      (activity.kind === "provider.approval.respond.failed" &&
        isStaleRequestFailure(activity.kind, payload))
    ) {
      closedApprovals.add(requestId);
      approvals.delete(requestId);
    } else if (
      activity.kind === "user-input.resolved" ||
      (activity.kind === "provider.user-input.respond.failed" &&
        isStaleRequestFailure(activity.kind, payload))
    ) {
      closedUserInputs.add(requestId);
      userInputs.delete(requestId);
    }
  }

  const byCreatedAt = (
    left: { readonly createdAt: string },
    right: { readonly createdAt: string },
  ) => left.createdAt.localeCompare(right.createdAt);
  return {
    approvals: [...approvals.values()].sort(byCreatedAt),
    userInputs: [...userInputs.values()].sort(byCreatedAt),
  };
}
