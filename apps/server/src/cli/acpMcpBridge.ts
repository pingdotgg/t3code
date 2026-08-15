import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";

import { runAcpMcpCliFastPath } from "../mcp/AcpMcpStdioBridge.ts";

/**
 * `t3 acp-mcp-bridge` — internal stdio MCP server that ACP agents spawn.
 *
 * The T3 server injects this command (with per-session endpoint and
 * credential environment variables) into `session/new` so every ACP agent
 * reaches the t3-code toolkit through ACP's required stdio MCP transport.
 * The credential stays in the environment, never on the command line.
 *
 * Real invocations dispatch through the bin.ts fast path before the CLI
 * graph loads; these definitions keep the commands wired for help and for
 * anything that drives the full CLI programmatically.
 */
export const acpMcpBridgeCommand = Command.make("acp-mcp-bridge").pipe(
  Command.withDescription("Bridge T3 Code's MCP endpoint to stdio for ACP agents."),
  Command.withHidden,
  Command.withHandler(() => Effect.promise(() => runAcpMcpCliFastPath("acp-mcp-bridge", []))),
);

/** Terminal fallback for ACP agents that do not expose injected MCP servers. */
export const acpMcpCallCommand = Command.make("acp-mcp-call", {
  tool: Argument.string("tool"),
  argumentsJson: Argument.string("arguments-json"),
}).pipe(
  Command.withDescription("Call one T3 Code MCP tool from an ACP agent terminal."),
  Command.withHidden,
  Command.withHandler(({ tool, argumentsJson }) =>
    Effect.promise(() => runAcpMcpCliFastPath("acp-mcp-call", [tool, argumentsJson])),
  ),
);
