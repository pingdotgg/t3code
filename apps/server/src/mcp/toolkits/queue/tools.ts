import {
  QueueMcpCancelInput,
  QueueMcpCancelResult,
  QueueMcpEditInput,
  QueueMcpEditResult,
  QueueMcpFailure,
  QueueMcpListInput,
  QueueMcpListResult,
  QueueMcpPromoteInput,
  QueueMcpPromoteResult,
  QueueMcpReadInput,
  QueueMcpReadResult,
  QueueMcpReorderInput,
  QueueMcpReorderResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { QueueMcpService } from "../../QueueMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, QueueMcpService];

export const QueueListTool = Tool.make("t3_queue_list", {
  description:
    "List queued follow-up runs in delivery order for this thread, or another thread in the same project. Results and message text are bounded; continue with nextCursor.",
  parameters: QueueMcpListInput,
  success: QueueMcpListResult,
  failure: QueueMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List queued work")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const QueueReadTool = Tool.make("t3_queue_read", {
  description:
    "Read one queued run and its durable message and attachment references. The run must still be queued in the selected same-project thread.",
  parameters: QueueMcpReadInput,
  success: QueueMcpReadResult,
  failure: QueueMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read queued work")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const QueueEditTool = Tool.make("t3_queue_edit", {
  description:
    "Edit a queued follow-up message. Omit attachmentIds to preserve attachments; pass [] to clear them; otherwise pass attachment IDs already owned by the target thread. Active and terminal runs are rejected.",
  parameters: QueueMcpEditInput,
  success: QueueMcpEditResult,
  failure: QueueMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Edit queued work")
  .annotate(Tool.Destructive, true);

export const QueueReorderTool = Tool.make("t3_queue_reorder", {
  description:
    "Move a queued user message before another queued run, or pass beforeRunId=null to move it to the end. Automatic completion deliveries keep priority and cannot be moved. Check outcome: receipt_replayed means this retry did not apply the requested destination; list the queue for current order.",
  parameters: QueueMcpReorderInput,
  success: QueueMcpReorderResult,
  failure: QueueMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Reorder queued work")
  .annotate(Tool.Destructive, true);

export const QueueCancelTool = Tool.make("t3_queue_cancel", {
  description:
    "Cancel a queued run without interrupting active work. Active and terminal runs are rejected by the serialized V2 queue command.",
  parameters: QueueMcpCancelInput,
  success: QueueMcpCancelResult,
  failure: QueueMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel queued work")
  .annotate(Tool.Destructive, true);

export const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
  description:
    "Promote a queued user message into a steerable active run. The selected provider must support its active steering path; unsupported, stale, and non-running targets are rejected without cancelling the queued run.",
  parameters: QueueMcpPromoteInput,
  success: QueueMcpPromoteResult,
  failure: QueueMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Promote queued work to steering")
  .annotate(Tool.Destructive, true);

export const QueueToolkit = Toolkit.make(
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueReorderTool,
  QueueCancelTool,
  QueuePromoteTool,
);
