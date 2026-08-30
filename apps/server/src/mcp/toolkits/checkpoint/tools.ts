import {
  CheckpointMcpDiffInput,
  CheckpointMcpDiffResult,
  CheckpointMcpFailure,
  CheckpointMcpListInput,
  CheckpointMcpListResult,
  CheckpointMcpRestoreInput,
  CheckpointMcpRestoreResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CheckpointMcpService } from "../../CheckpointMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, CheckpointMcpService];

export const CheckpointListTool = Tool.make("t3_checkpoint_list", {
  description:
    "List durable filesystem checkpoints for this thread or another thread in the same project. Results are newest first, bounded and paginated, and include stable checkpoint/scope identity, source metadata, bounded file summaries, filesystem-ref availability, and current provider rollback support. Availability is checked only for the returned page.",
  parameters: CheckpointMcpListInput,
  success: CheckpointMcpListResult,
  failure: CheckpointMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List thread checkpoints")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CheckpointDiffTool = Tool.make("t3_checkpoint_diff", {
  description:
    "Read a bounded patch between two durable checkpoints in one thread checkpoint scope. Use t3_checkpoint_list first to select stable checkpointId and scopeId values. The thread and both checkpoint identities are validated before an empty diff is returned; arbitrary filesystem paths or Git refs are not accepted. Pagination cursors count UTF-16 code units.",
  parameters: CheckpointMcpDiffInput,
  success: CheckpointMcpDiffResult,
  failure: CheckpointMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a checkpoint diff")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CheckpointRestoreTool = Tool.make("t3_checkpoint_restore", {
  description:
    "Request restoration of an exact durable checkpoint through the serialized V2 checkpoint.rollback workflow. This discards current tracked and untracked workspace changes covered by Git restore, so discardChanges must be true. The thread must be idle with no queued work, the provider must support conversation rollback, and the workspace must remain unchanged between preflight and the locked restore. Reuse the exact clientRequestId to read the original accepted command/effect status without repeating it. REQUESTED means accepted but not yet applied; PARTIAL means the filesystem was restored but provider conversation rollback failed.",
  parameters: CheckpointMcpRestoreInput,
  success: CheckpointMcpRestoreResult,
  failure: CheckpointMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Restore a thread checkpoint")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const CheckpointToolkit = Toolkit.make(
  CheckpointListTool,
  CheckpointDiffTool,
  CheckpointRestoreTool,
);
