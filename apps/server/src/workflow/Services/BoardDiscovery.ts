import type { BoardListEntry, ProjectId } from "@t3tools/contracts";
import { WorkflowRpcError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface BoardDiscoveryShape {
  readonly discover: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BoardListEntry>, WorkflowRpcError>;
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BoardListEntry>, WorkflowRpcError>;
}

export class BoardDiscovery extends Context.Service<BoardDiscovery, BoardDiscoveryShape>()(
  "t3/workflow/Services/BoardDiscovery",
) {}
