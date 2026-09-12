import { ProjectSearchContentsInput, ProjectSearchEntriesInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndexRefreshFailed,
  WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndexSearchFailed,
} from "./WorkspaceSearchIndexService.ts";

export const SearchOperation = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("initialize"),
    cwd: Schema.String,
    variant: Schema.Literals(["paths", "content"]),
  }),
  Schema.Struct({ method: Schema.Literal("list") }),
  Schema.Struct({ method: Schema.Literal("refresh") }),
  Schema.Struct({ method: Schema.Literal("dispose") }),
  Schema.Struct({
    method: Schema.Literal("search"),
    ...Struct.omit(ProjectSearchEntriesInput.fields, ["cwd"]),
  }),
  Schema.Struct({
    method: Schema.Literal("searchContents"),
    input: Schema.Struct(Struct.omit(ProjectSearchContentsInput.fields, ["cwd"])),
  }),
]);
export type SearchOperation = typeof SearchOperation.Type;
export const SearchRequest = Schema.Struct({ id: Schema.Int, operation: SearchOperation });
export type SearchRequest = typeof SearchRequest.Type;

export const SearchResponse = Schema.toCodecJson(
  Schema.Exit(
    Schema.Unknown,
    Schema.Union([
      WorkspaceSearchIndexCreateFailed,
      WorkspaceSearchIndexScanTimedOut,
      WorkspaceSearchIndexSearchFailed,
      WorkspaceSearchIndexRefreshFailed,
    ]),
    Schema.Defect(),
  ),
);
