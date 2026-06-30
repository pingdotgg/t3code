import type { BoardId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type WorkflowBoardVersionSource =
  | "create"
  | "save"
  | "revert"
  | "import"
  | "rename"
  | "self-improve"
  | "self-improve-revert";

export interface WorkflowBoardVersionRecordInput {
  readonly boardId: BoardId;
  readonly versionHash: string;
  readonly contentJson: string;
  readonly source: WorkflowBoardVersionSource;
}

export interface WorkflowBoardVersionSummaryRow {
  readonly versionId: number;
  readonly versionHash: string;
  readonly source: WorkflowBoardVersionSource;
  readonly createdAt: string;
}

export interface WorkflowBoardVersionRow extends WorkflowBoardVersionSummaryRow {
  readonly contentJson: string;
}

export interface WorkflowBoardVersionStoreShape {
  readonly record: (
    input: WorkflowBoardVersionRecordInput,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly list: (
    boardId: BoardId,
  ) => Effect.Effect<ReadonlyArray<WorkflowBoardVersionSummaryRow>, WorkflowEventStoreError>;
  readonly get: (
    boardId: BoardId,
    versionId: number,
  ) => Effect.Effect<WorkflowBoardVersionRow | null, WorkflowEventStoreError>;
  readonly deleteForBoard: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowBoardVersionStore extends Context.Service<
  WorkflowBoardVersionStore,
  WorkflowBoardVersionStoreShape
>()("t3/workflow/Services/WorkflowBoardVersionStore") {}
