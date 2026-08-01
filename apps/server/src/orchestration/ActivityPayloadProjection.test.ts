import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload,
    turnId: null,
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("projectActivityPayload", () => {
  it("retains every nested field consumed by the web activity derivations", () => {
    const projected = projectActivityPayload(
      activity({
        itemId: "item-1",
        itemType: "command_execution",
        requestId: "request-1",
        detail: "Ran tests",
        provider: "copilot",
        data: {
          agentRunId: "agent-1",
          toolCallId: "tool-1",
          kind: "execute",
          item: {
            input: { command: ["pnpm", "test"] },
            ignored: "x".repeat(10_000),
          },
          changes: [{ path: "src/index.ts", patch: "x".repeat(10_000) }],
          rawOutput: { stdout: `passed\n${"x".repeat(10_000)}` },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemId: "item-1",
      itemType: "command_execution",
      requestId: "request-1",
      detail: "Ran tests",
      provider: "copilot",
      data: {
        agentRunId: "agent-1",
        toolCallId: "tool-1",
        kind: "execute",
        item: { input: { command: ["pnpm", "test"] } },
        files: [{ path: "src/index.ts" }],
        rawOutput: { content: "passed" },
      },
    });
  });

  it("leaves MCP activities unchanged", () => {
    const original = activity({
      itemType: "mcp_tool_call",
      data: { result: "must remain available" },
    });
    expect(projectActivityPayload(original)).toBe(original);
  });

  it("substantially reduces representative bulky tool payloads", () => {
    const original = activity({
      itemType: "file_change",
      data: {
        rawInput: "x".repeat(50_000),
        rawOutput: { content: "y".repeat(50_000) },
        files: [{ path: "src/large.ts", patch: "z".repeat(50_000) }],
      },
    });
    const projected = projectActivityPayload(original);
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(original).length * 0.02);
  });

  it("preserves every changed file path used by exact UI counts", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        data: {
          changes: paths.map((path) => ({ path, patch: "large patch contents" })),
        },
      }),
    );
    const payload = projected.payload as {
      data: { files: ReadonlyArray<{ path: string }> };
    };
    expect(payload.data.files.map((file) => file.path)).toEqual(paths);
  });
});
