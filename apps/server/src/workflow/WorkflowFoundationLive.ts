import * as Layer from "effect/Layer";

import { BoardRegistryLive } from "./Layers/BoardRegistry.ts";
import { StepOutputHandoffReaderLive } from "./Layers/StepOutputHandoffReader.ts";
import { WorkflowAgentSessionStoreLive } from "./Layers/WorkflowAgentSessionStore.ts";
import { WorkflowEventStoreLive } from "./Layers/WorkflowEventStore.ts";
import { WorkflowBoardVersionStoreLive } from "./Layers/WorkflowBoardVersionStore.ts";
import { WorkflowProjectionPipelineLive } from "./Layers/WorkflowProjectionPipeline.ts";
import { WorkflowReadModelLive } from "./Layers/WorkflowReadModel.ts";

// WorkflowReadModelLive resolves current-lane actions from board definitions,
// so it requires BoardRegistry. We provideMerge BoardRegistryLive here: this
// both satisfies the read model's requirement and re-exports BoardRegistry as
// part of the foundation, so the registry boards are registered into is the
// same instance the read model reads. Effect memoizes layers by reference, so
// consumers that also reference BoardRegistryLive share this one instance.
export const WorkflowFoundationLive = Layer.mergeAll(
  WorkflowEventStoreLive,
  WorkflowBoardVersionStoreLive,
  WorkflowAgentSessionStoreLive,
  StepOutputHandoffReaderLive,
  WorkflowProjectionPipelineLive,
  WorkflowReadModelLive,
).pipe(Layer.provideMerge(BoardRegistryLive));
