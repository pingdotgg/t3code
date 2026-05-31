import { buildToolTree, type ToolTreeFromRefs } from "./t3work-sdk.ts";
import { renameThreadTool } from "./tools/t3work-sdk.t3work.ts";

export const BUILTIN_TOOL_REFS = [renameThreadTool] as const;
export type BuiltinToolsTree = ToolTreeFromRefs<typeof BUILTIN_TOOL_REFS>;

export const builtinTools = buildToolTree(BUILTIN_TOOL_REFS);
