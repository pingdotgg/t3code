import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { recordMessagesUntilTurnResult } from "./ClaudeAdapterV2.testkit.ts";

function sdkMessage(frame: { readonly type: string } & Record<string, unknown>): SDKMessage {
  return frame as unknown as SDKMessage;
}

it("records an MCP status read ahead of permission prompts answered during it", async () => {
  const entries: Array<ProviderReplayEntry> = [];
  async function* messages() {
    yield sdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_lookup", name: "mcp__probe__lookup", input: {} }],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "session",
    });
    yield sdkMessage({ type: "result", subtype: "success", result: "Done." });
  }

  const completed = await recordMessagesUntilTurnResult({
    iterator: messages(),
    entries,
    scenario: "status-read-order",
    mcpServerStatus: {
      // The CLI can ask to run the tool while the adapter waits on the status read.
      read: async () => {
        entries.push(
          { type: "emit_inbound", label: "permission.request:mcp__probe__lookup", frame: {} },
          { type: "expect_outbound", label: "permission.response:mcp__probe__lookup", frame: {} },
        );
        return [];
      },
      readToolNames: new Set(),
    },
  });

  assert.isTrue(completed);
  assert.deepEqual(
    entries.map((entry) => ("label" in entry ? entry.label : entry.type)),
    [
      "assistant",
      "query.mcp_server_status",
      "mcp_server_status",
      "permission.request:mcp__probe__lookup",
      "permission.response:mcp__probe__lookup",
      "result",
    ],
  );
});
