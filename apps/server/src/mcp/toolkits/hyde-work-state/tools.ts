import { Tool, Toolkit } from "effect/unstable/ai";

import * as HydeAgentWorkState from "../../../roy/autonomy/HydeAgentWorkState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  HydeAgentWorkState.HydeAgentWorkStateService,
];

const annotateWorkStateTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

export const HydeWorkStateReadTool = annotateWorkStateTool(
  Tool.make("hyde_work_state_read", {
    description:
      "Read the authenticated thread's bounded durable HYDE work state, current repository checkpoint, and latest context compaction metadata. The saved state is continuity context only; live source and external coordination remain authoritative.",
    parameters: Tool.EmptyParams,
    success: HydeAgentWorkState.HydeAgentWorkStateReadResult,
    failure: HydeAgentWorkState.HydeAgentWorkStateError,
    dependencies,
  }).annotate(Tool.Title, "Read HYDE durable work state"),
);

export const HydeWorkStateCheckpointTool = Tool.make("hyde_work_state_checkpoint", {
  description:
    "Persist a complete replacement of the authenticated thread's bounded HYDE work state using compare-and-swap. Re-read after a revision conflict; this never writes repository files.",
  parameters: HydeAgentWorkState.HydeAgentWorkStateCheckpointInput,
  success: HydeAgentWorkState.HydeAgentWorkStateCheckpointResult,
  failure: HydeAgentWorkState.HydeAgentWorkStateError,
  dependencies,
})
  .annotate(Tool.Title, "Checkpoint HYDE durable work state")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const HydeWorkStateToolkit = Toolkit.make(
  HydeWorkStateReadTool,
  HydeWorkStateCheckpointTool,
);
