import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  /** App requesting access for mcp-elicitation approvals (#8058). */
  readonly appName?: string;
  /** Approval choices advertised by the provider (#8058); defaults apply when absent. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

/** Joins pending request entities to the request items that carry display data. */
export function derivePendingThreadRequests(
  projection: OrchestrationV2ThreadProjection,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
    });
  }

  return { approvals, userInputs };
}
