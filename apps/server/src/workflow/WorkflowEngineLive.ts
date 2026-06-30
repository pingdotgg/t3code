import * as Layer from "effect/Layer";

import { ApprovalGateLive } from "./Layers/ApprovalGate.ts";
import { BoardRegistryLive } from "./Layers/BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./Layers/PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./Layers/WorkflowBoardSaveLocks.ts";
import { WorkflowEngineLayer } from "./Layers/WorkflowEngine.ts";
import { WorkflowEventCommitterLive } from "./Layers/WorkflowEventCommitter.ts";
import { WorkflowIdsLive } from "./Layers/WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./Layers/WorkflowRoutingContextBuilder.ts";
import { WorkflowFoundationLive } from "./WorkflowFoundationLive.ts";

export const WorkflowEngineCoreLive = WorkflowEngineLayer.pipe(
  Layer.provideMerge(WorkflowEventCommitterLive),
  Layer.provideMerge(ApprovalGateLive),
  // BoardRegistry is also re-exported by WorkflowFoundationLive below; same module export → Effect memoizes one instance.
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(PredicateEvaluatorLive),
  Layer.provideMerge(WorkflowRoutingContextBuilderLive),
  Layer.provideMerge(WorkflowBoardSaveLocksLive),
  Layer.provideMerge(WorkflowIdsLive),
  Layer.provideMerge(WorkflowFoundationLive),
);
