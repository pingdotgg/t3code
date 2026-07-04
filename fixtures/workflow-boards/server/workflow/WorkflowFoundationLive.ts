import type { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BoardRegistryLive } from "./Layers/BoardRegistry.ts";
import { WorkflowEventStoreLive } from "./Layers/WorkflowEventStore.ts";
import { WorkflowAgentSessionStoreLive } from "./Layers/WorkflowAgentSessionStore.ts";
import { WorkflowProjectionPipelineLive } from "./Layers/WorkflowProjectionPipeline.ts";
import { WorkflowReadModelLive } from "./Layers/WorkflowReadModel.ts";
import { NotificationSinkNoop } from "./NotificationSink.ts";
import { StepUsageReader } from "./Services/StepUsageReader.ts";
import { WorkflowAgentPort } from "./Services/WorkflowAgentPort.ts";

const WorkflowAgentPortNoop = Layer.succeed(WorkflowAgentPort, {
  ensureStarted: () => Effect.succeed({ messageId: "noop-message" as MessageId }),
  awaitTerminal: () => Effect.succeed({ ok: true }),
  awaitStepTerminal: () => Effect.succeed({ ok: true }),
  getDispatchForStep: () => Effect.succeed(null),
  confirmStep: () => Effect.void,
  readCapturedOutput: () => Effect.succeed(undefined),
  respond: () => Effect.void,
  isPendingRequestLive: () => Effect.succeed(true),
  cleanupSession: () => Effect.void,
  recoverPending: () => Effect.void,
} satisfies WorkflowAgentPort["Service"]);

const StepUsageReaderNoop = Layer.succeed(StepUsageReader, {
  read: () => Effect.succeed(undefined),
} satisfies StepUsageReader["Service"]);

export const WorkflowFoundationLive = Layer.mergeAll(
  WorkflowEventStoreLive,
  WorkflowAgentSessionStoreLive,
  WorkflowProjectionPipelineLive,
  WorkflowReadModelLive,
  WorkflowAgentPortNoop,
  StepUsageReaderNoop,
  NotificationSinkNoop,
).pipe(Layer.provideMerge(BoardRegistryLive));
