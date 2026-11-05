import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

// Native Claude children share the query's MCP client; the trusted SDK hook narrows their access.
export const limitNativeChildOrbit: HookCallback = (input) => {
  if (
    input.hook_event_name !== "PreToolUse" ||
    input.agent_id === undefined ||
    !/^mcp__t3[-_]code__orbit$/.test(input.tool_name)
  )
    return Promise.resolve({});
  const operation =
    typeof input.tool_input === "object" &&
    input.tool_input !== null &&
    "operation" in input.tool_input
      ? input.tool_input.operation
      : undefined;
  return Promise.resolve(
    operation === "orbit_context"
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "Native subagents may only read their inherited Orbit context. Return proposed updates to the parent.",
          },
        },
  );
};
