import {
  CheckpointMcpDiffInput,
  CheckpointMcpDiffResult,
  CheckpointMcpFailure,
  CheckpointMcpListInput,
  CheckpointMcpListResult,
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

export const CheckpointToolkit = Toolkit.make(CheckpointListTool, CheckpointDiffTool);
