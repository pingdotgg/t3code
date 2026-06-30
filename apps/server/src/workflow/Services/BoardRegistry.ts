import type { BoardId, LaneKey, WorkflowDefinition, WorkflowLane } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class BoardRegistryError extends Schema.TaggedErrorClass<BoardRegistryError>()(
  "BoardRegistryError",
  { message: Schema.String },
) {}

export interface BoardRegistryShape {
  readonly register: (
    boardId: BoardId,
    definition: unknown,
  ) => Effect.Effect<WorkflowDefinition, BoardRegistryError>;
  readonly unregister: (boardId: BoardId) => Effect.Effect<void>;
  readonly getDefinition: (boardId: BoardId) => Effect.Effect<WorkflowDefinition | null>;
  readonly listDefinitions: () => Effect.Effect<
    ReadonlyArray<{
      readonly boardId: BoardId;
      readonly definition: WorkflowDefinition;
    }>
  >;
  readonly getLane: (boardId: BoardId, laneKey: LaneKey) => Effect.Effect<WorkflowLane | null>;
}

export class BoardRegistry extends Context.Service<BoardRegistry, BoardRegistryShape>()(
  "t3/workflow/Services/BoardRegistry",
) {}
