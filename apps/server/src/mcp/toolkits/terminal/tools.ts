import { Tool, Toolkit } from "effect/unstable/ai";

import { TerminalRunInput, TerminalSessionSnapshot } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, TerminalManager.TerminalManager];

const destructiveTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

export const TerminalRunTool = destructiveTool(
  Tool.make("terminal_run", {
    description:
      "Open the scoped thread's built-in terminal, send one shell command, and return the session snapshot.",
    parameters: TerminalRunInput,
    success: TerminalSessionSnapshot,
    failure: TerminalManager.TerminalError,
    dependencies,
  }).annotate(Tool.Title, "Run terminal command"),
);

export const TerminalToolkit = Toolkit.make(TerminalRunTool);
