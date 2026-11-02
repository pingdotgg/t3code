// The user's answer is the only way a delegation card leaves pending as approved. No MCP
// tool calls this; `delegate_task` waits on the card and starts the task itself.
import {
  CommandId,
  DelegationApprovalError,
  type DelegationApprovalAnswerInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export class DelegationApprovals extends Context.Service<
  DelegationApprovals,
  {
    readonly answer: (
      input: DelegationApprovalAnswerInput,
    ) => Effect.Effect<void, DelegationApprovalError>;
  }
>()("t3/mcp/DelegationApprovals") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const answer: DelegationApprovals["Service"]["answer"] = Effect.fn("DelegationApprovals.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "delegation_approval.decision": input.decision,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["delegation_approval"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new DelegationApprovalError({ reason: "load_failed", cause })),
        );
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "delegation_approval" || item.runId === null || item.nodeId === null) {
        return yield* new DelegationApprovalError({ reason: "not_found" });
      }
      if (item.approvalStatus !== "pending") {
        return yield* new DelegationApprovalError({ reason: "already_answered" });
      }
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || !ThreadManagementService.isActiveRun(run)) {
        return yield* new DelegationApprovalError({ reason: "agent_stopped" });
      }
      const approvalStatus = input.decision === "approve" ? "approved" : "declined";
      yield* threadManagement
        .dispatch({
          type: "delegation_approval.record",
          commandId: CommandId.make(`delegation-approval:${item.id}:${approvalStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          title: item.title ?? "Delegate a task",
          task: item.task,
          current: item.current,
          proposed: item.proposed,
          ...(item.environmentId === undefined ? {} : { environmentId: item.environmentId }),
          approvalStatus,
        })
        .pipe(
          Effect.mapError(
            (cause) => new DelegationApprovalError({ reason: "record_failed", cause }),
          ),
        );
      // The first answer stands, so a racing cancel or other answer may have won.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["delegation_approval"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError(
            (cause) => new DelegationApprovalError({ reason: "record_failed", cause }),
          ),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type === "delegation_approval" && card.approvalStatus !== approvalStatus) {
        return yield* new DelegationApprovalError({ reason: "already_answered" });
      }
    },
  );

  return DelegationApprovals.of({ answer });
});

export const layer = Layer.effect(DelegationApprovals, make);
