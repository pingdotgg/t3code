import { CommandId, EventId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionPendingApproval } from "../persistence/Services/ProjectionPendingApprovals.ts";
import type { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export const dismissPendingApprovals = Effect.fn("dismissPendingApprovals")(function* (
  engine: OrchestrationEngineService["Service"],
  approvals: ReadonlyArray<ProjectionPendingApproval>,
  createdAt: string,
) {
  for (const approval of approvals) {
    const id = `server:approval-dismissed:${approval.requestId}:${approval.createdAt}`;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(id),
      threadId: approval.threadId,
      activity: {
        id: EventId.make(id),
        kind: "approval.resolved",
        tone: "info",
        summary: "Approval dismissed",
        payload: { requestId: approval.requestId },
        turnId: approval.turnId,
        createdAt,
      },
      createdAt,
    });
  }
});
