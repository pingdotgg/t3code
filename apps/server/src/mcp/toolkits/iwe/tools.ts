import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as IweService from "../../../iwe/IweService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    IweService.IweService,
    ThreadManagementService.ThreadManagementService,
    Project.ProjectService,
  ],
};

const FindTool = Tool.make("continuum_iwe_find", {
  ...shared,
  description:
    "Search this thread's IWE notes workspace with IWE's own search: fuzzy on titles and keys, lexical (BM25) on full text, or both. Each result lists the note's links and backlinks. With no query, lists the most linked notes.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Schema.Literals(["fuzzy", "lexical", "both"])),
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const RetrieveTool = Tool.make("continuum_iwe_retrieve", {
  ...shared,
  description:
    "Read IWE notes by key with related notes pulled in: notes they link to (references), notes that link to them (backlinks), and inclusion parents and children, to the depth you ask. Returns Markdown with each note's links in its frontmatter.",
  parameters: Schema.Struct({
    keys: Schema.Array(Schema.String),
    references: Schema.optionalKey(Schema.Number),
    backlinks: Schema.optionalKey(Schema.Number),
    children: Schema.optionalKey(Schema.Number),
    parents: Schema.optionalKey(Schema.Number),
  }),
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const WriteTool = Tool.make("continuum_iwe_write", {
  ...shared,
  description:
    "Create or update an IWE note through the iwe CLI. update replaces the note's full Markdown (keep its title heading and existing links). create takes a key (such as projects/roadmap, without .md) or a title, and writes Markdown that starts with a # heading. Link other notes the way the workspace already does, for example [Title](key.md).",
  parameters: Schema.Struct({
    mode: Schema.Literals(["create", "update"]),
    content: Schema.String,
    key: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Unknown,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const RenameTool = Tool.make("continuum_iwe_rename", {
  ...shared,
  description:
    "Rename an IWE note's key and update every link to it across the workspace, with IWE's own rename.",
  parameters: Schema.Struct({ key: Schema.String, newKey: Schema.String }),
  success: Schema.Unknown,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const IweToolkit = Toolkit.make(FindTool, RetrieveTool, WriteTool, RenameTool);
