import * as Layer from "effect/Layer";

import { ApprovalGateLive } from "./Layers/ApprovalGate.ts";
import { DurableApprovalResumeLive } from "./Layers/DurableApprovalResume.ts";
import { ScriptCancelRegistryLive } from "./Layers/ScriptCancelRegistry.ts";
import { StepUsageReaderLive } from "./Layers/StepUsageReader.ts";
import { WorkflowAgentSessionStoreLive } from "./Layers/WorkflowAgentSessionStore.ts";
import { WorkflowAgentPortLive } from "./Layers/WorkflowAgentPort.ts";
import { WorkflowBoardVersionStoreLive } from "./Layers/WorkflowBoardVersionStore.ts";
import { WorkflowEngineLayer } from "./Layers/WorkflowEngine.ts";
import { WorkflowRecoveryLive } from "./Layers/WorkflowRecovery.ts";
import { WorkflowRoutingContextBuilderLive } from "./Layers/WorkflowRoutingContextBuilder.ts";
import { WorkflowSourceCommitterLive } from "./Layers/WorkflowSourceCommitter.ts";
import { WorkSourceConnectionStoreLive } from "./Layers/WorkSourceConnectionStore.ts";
import { WorktreeLeaseServiceLive } from "./Layers/WorktreeLeaseService.ts";
import { WorkflowCoreLive } from "./WorkflowCoreLive.ts";
import { WorkflowStepExecutorLive } from "./WorkflowStepExecutorLive.ts";

const WorkflowEngineSupportBaseLive = Layer.mergeAll(
  ApprovalGateLive,
  ScriptCancelRegistryLive,
  WorkflowRoutingContextBuilderLive,
  StepUsageReaderLive,
  WorkflowAgentSessionStoreLive,
  WorkflowBoardVersionStoreLive,
  WorktreeLeaseServiceLive,
);

const WorkflowEngineSupportLive = WorkflowStepExecutorLive.pipe(
  Layer.provideMerge(WorkflowEngineSupportBaseLive),
);

const WorkflowEngineAndRecoveryLive = Layer.mergeAll(
  WorkflowRecoveryLive,
  WorkflowSourceCommitterLive,
  WorkSourceConnectionStoreLive,
).pipe(Layer.provideMerge(WorkflowEngineLayer));

export const WorkflowEngineCoreLive = WorkflowEngineAndRecoveryLive.pipe(
  Layer.provideMerge(DurableApprovalResumeLive),
  Layer.provideMerge(WorkflowEngineSupportLive),
  Layer.provideMerge(WorkflowCoreLive),
  Layer.provideMerge(WorkflowAgentPortLive),
);
