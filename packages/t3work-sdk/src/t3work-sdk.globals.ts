import type { BuiltinToolsTree } from "./t3work-sdk.builtins.ts";
import type { RegisteredWorkflowScriptsTree, RegisteredWorkflowToolsTree } from "./t3work-sdk.ts";

export {};

declare global {
  const tools: BuiltinToolsTree & RegisteredWorkflowToolsTree;
  const scripts: RegisteredWorkflowScriptsTree;
}
