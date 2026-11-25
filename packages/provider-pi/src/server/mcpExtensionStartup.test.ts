import { assert, it } from "@effect/vitest";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

it.each([204, 404, "offline"] as const)(
  "restores Pi's active tool loadout after a startup retry (DELETE %s)",
  async (deleteResult) => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      activatesOnRegistration: true,
      startupRetry: { deleteResult },
    });

    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { model: { api: "openai-completions" }, ui: { notify: assert.fail } },
    );

    assert.deepEqual(bridge.sessionTerminationAttempts, [
      { sessionId: "1", authorization: "Bearer fixture-token" },
    ]);
    assert.include(bridge.getActiveTools(), "tool_search");
    assert.notInclude(bridge.getActiveTools(), "mcp__t3_code__orchestrator_capabilities");
    const result = await bridge.callModelTool("mcp__t3-code__preview_snapshot", {});
    assert.deepEqual(result.content, [{ type: "text", text: "browser snapshot" }]);
  },
);
