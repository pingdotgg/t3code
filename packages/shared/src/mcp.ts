export { MIN_MCP_TOOL_TIMEOUT_SEC } from "@t3tools/contracts";
import { MIN_MCP_TOOL_TIMEOUT_SEC } from "@t3tools/contracts";

export const DEFAULT_MCP_TOOL_TIMEOUT_SEC = 120;
export const MAX_MCP_TOOL_TIMEOUT_MS = 2_147_483_647;

export function normalizeMcpToolTimeoutSec(
  value: unknown,
  defaultValue = DEFAULT_MCP_TOOL_TIMEOUT_SEC,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_MCP_TOOL_TIMEOUT_SEC
  ) {
    return defaultValue;
  }
  return value;
}

export function mcpToolTimeoutMsFromSeconds(
  toolTimeoutSec: number | undefined,
): number | undefined {
  if (
    toolTimeoutSec === undefined ||
    !Number.isFinite(toolTimeoutSec) ||
    !Number.isInteger(toolTimeoutSec) ||
    toolTimeoutSec < MIN_MCP_TOOL_TIMEOUT_SEC
  ) {
    return undefined;
  }
  return Math.min(MAX_MCP_TOOL_TIMEOUT_MS, toolTimeoutSec * 1000);
}
