import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as MemoryVaultService from "../../../memoryVaults/MemoryVaultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, MemoryVaultService.MemoryVaultService],
};

const NotePath = Schema.String.annotate({
  description: "A .md or .txt file in the vault, such as DECISIONS.md or notes/auth.md.",
});

const MemorySearchTool = Tool.make("continuum_memory_search", {
  ...shared,
  description:
    "Search this thread's project memory vault (notes the user keeps across projects and agents) for sections about a topic.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({
    vault: Schema.String,
    hits: Schema.Array(
      Schema.Struct({ path: Schema.String, heading: Schema.String, excerpt: Schema.String }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const MemoryReadTool = Tool.make("continuum_memory_read", {
  ...shared,
  description:
    "Read a note from this thread's project memory vault, or list its notes when `path` is omitted.",
  parameters: Schema.Struct({ path: Schema.optionalKey(NotePath) }),
  success: Schema.Struct({
    vault: Schema.String,
    access: Schema.String,
    files: Schema.Array(Schema.String),
    content: Schema.optionalKey(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const MemoryUpdateTool = Tool.make("continuum_memory_update", {
  ...shared,
  description:
    "Record durable knowledge in this thread's project memory vault: decisions, architecture, finished or remaining tasks, bugs and fixes, user preferences. `append` adds an entry; `replace_section` rewrites the body under a heading; `replace_file` rewrites the note. Keep entries short, never include secrets.",
  parameters: Schema.Struct({
    path: NotePath,
    mode: Schema.Literals(["append", "replace_section", "replace_file"]),
    content: Schema.String,
    section: Schema.optionalKey(
      Schema.String.annotate({ description: "Heading text, for replace_section." }),
    ),
  }),
  success: Schema.Struct({
    vault: Schema.String,
    path: Schema.String,
    chars: Schema.Number,
    redactedSecrets: Schema.Number,
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const MemoryToolkit = Toolkit.make(MemorySearchTool, MemoryReadTool, MemoryUpdateTool);
