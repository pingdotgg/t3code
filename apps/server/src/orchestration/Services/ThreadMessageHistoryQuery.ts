import type {
  OrchestrationGetThreadMessagesPageInput,
  OrchestrationGetThreadMessagesPageResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ThreadMessageHistoryQueryShape {
  readonly getThreadMessagesPage: (
    input: OrchestrationGetThreadMessagesPageInput,
  ) => Effect.Effect<OrchestrationGetThreadMessagesPageResult, ProjectionRepositoryError>;
}

export class ThreadMessageHistoryQuery extends ServiceMap.Service<
  ThreadMessageHistoryQuery,
  ThreadMessageHistoryQueryShape
>()("t3/orchestration/Services/ThreadMessageHistoryQuery") {}
