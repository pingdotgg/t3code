import { expect, it } from "@effect/vitest";
import { limitNativeChildOrbit } from "./claudeOrbitPolicy.ts";

it("limits native child calls even when they inherit a parent's MCP client", async () => {
  const base = {
    hook_event_name: "PreToolUse" as const,
    session_id: "session",
    transcript_path: "/tmp/transcript",
    cwd: "/repo",
    tool_name: "mcp__t3-code__orbit",
    tool_use_id: "call",
  };
  const options = { signal: new AbortController().signal };
  for (const operation of [
    "ticket_update",
    "create_ticket",
    "start_thread",
    "ticket_get",
    undefined,
  ]) {
    const child = await limitNativeChildOrbit(
      { ...base, agent_id: "native-child", tool_input: { operation } },
      undefined,
      options,
    );
    expect(child).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const parent = await limitNativeChildOrbit(
      { ...base, agent_type: "general-purpose", tool_input: { operation } },
      undefined,
      options,
    );
    expect(parent).toEqual({});
  }
  expect(
    await limitNativeChildOrbit(
      { ...base, agent_id: "native-child", tool_input: { operation: "orbit_context" } },
      undefined,
      options,
    ),
  ).toEqual({});
});
