import { describe, expect, it } from "vite-plus/test";

import { orbitTaskCreateReceiptFromTool } from "./taskReceipt.ts";

const ROW = {
  id: 5753,
  title: "Executor slice 4",
  status: "todo",
  attention: null,
  project: { id: 78, slug: "orbit", name: "Orbit", code: "ORB" },
  workspace: null,
  pull_request: null,
  subtask_counts: { total: 3, todo: 3, running: 0, completed: 0, failed: 0, cancelled: 0 },
  created_at: "2026-11-17T11:30:00+00:00",
  updated_at: "2026-11-17T11:30:00+00:00",
  last_activity_at: null,
};
const BODY = { data: ROW };

describe("orbitTaskCreateReceiptFromTool", () => {
  it.each([
    ["Claude Code", "mcp__orbit__task-create"],
    ["dotted", "orbit.task-create"],
    ["underscored", " orbit:task_create "],
  ])("reads the %s tool name", (_label, toolName) => {
    expect(orbitTaskCreateReceiptFromTool(toolName, BODY)?.id).toBe(5753);
  });

  it.each([
    ["a bare value", BODY],
    ["JSON text", JSON.stringify(BODY)],
    ["MCP content blocks", [{ type: "text", text: JSON.stringify(BODY) }]],
    ["structured content", { structuredContent: BODY }],
    ["the wire's compact output", { orbitTask: ROW }],
    ["a content wrapper", { content: [{ type: "text", text: JSON.stringify(BODY) }] }],
  ])("unwraps %s", (_label, output) => {
    expect(orbitTaskCreateReceiptFromTool("mcp__orbit__task-create", output)).toMatchObject({
      id: 5753,
      title: "Executor slice 4",
      subtaskCounts: { total: 3 },
    });
  });

  it("ignores other tools, a missing name and unreadable results", () => {
    expect(orbitTaskCreateReceiptFromTool("mcp__orbit__task-list", BODY)).toBeNull();
    expect(orbitTaskCreateReceiptFromTool(null, BODY)).toBeNull();
    expect(orbitTaskCreateReceiptFromTool("mcp__orbit__task-create", "not json")).toBeNull();
    expect(orbitTaskCreateReceiptFromTool("mcp__orbit__task-create", { data: {} })).toBeNull();
  });
});
