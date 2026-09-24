import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const CHECKPOINT_DIFF_PAGE_ROWS = 256;
export const CHECKPOINT_DIFF_WINDOW_ROWS = CHECKPOINT_DIFF_PAGE_ROWS * 3;

export const CheckpointDiffRow = Schema.Struct({
  index: NonNegativeInt,
  fileIndex: NonNegativeInt,
  kind: Schema.Literals(["hunk", "line", "notice"]),
  content: Schema.String,
  change: Schema.Literals(["context", "add", "delete"]),
  oldLineNumber: Schema.NullOr(NonNegativeInt),
  newLineNumber: Schema.NullOr(NonNegativeInt),
  lineIndex: NonNegativeInt,
});
export type CheckpointDiffRow = typeof CheckpointDiffRow.Type;

export const CheckpointDiffFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  changeType: Schema.Literals(["change", "new", "deleted", "rename-pure", "rename-changed"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  rowStart: NonNegativeInt,
  rowCount: NonNegativeInt,
  lineCount: NonNegativeInt,
  lineStarts: Schema.Array(Schema.Struct({ lineIndex: NonNegativeInt, rowIndex: NonNegativeInt })),
});
export type CheckpointDiffFile = typeof CheckpointDiffFile.Type;

export const CheckpointDiffPage = Schema.Struct({
  revision: Schema.String,
  files: Schema.Array(CheckpointDiffFile),
  rowCount: NonNegativeInt,
  start: NonNegativeInt,
  rows: Schema.Array(CheckpointDiffRow),
});
export type CheckpointDiffPage = typeof CheckpointDiffPage.Type;
