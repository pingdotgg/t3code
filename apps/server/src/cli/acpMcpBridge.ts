import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { runAcpMcpCliFastPath } from "../mcp/AcpMcpStdioBridge.ts";

/** The credential stays in the environment, never on the command line. */
export const acpMcpBridgeCommand = Command.make("acp-mcp-bridge").pipe(
  Command.withDescription("Bridge T3 Code's MCP endpoint to stdio for ACP agents."),
  Command.unlisted,
  Command.withHandler(() => Effect.promise(() => runAcpMcpCliFastPath("acp-mcp-bridge", []))),
);

export const acpMcpCallCommand = Command.make("acp-mcp-call", {
  tool: Argument.String("tool"),
  argumentsJson: Argument.String("arguments-json"),
}).pipe(
  Command.withDescription("Call one T3 Code MCP tool from an ACP agent terminal."),
  Command.unlisted,
  Command.withHandler(({ tool, argumentsJson }) =>
    Effect.promise(() => runAcpMcpCliFastPath("acp-mcp-call", [tool, argumentsJson])),
  ),
);
