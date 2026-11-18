import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { vibeEffectSettled, vibeHistoryTurnItem } from "./historyItems.ts";

const base = {
  id: TurnItemId.make("item-1"),
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
};

const effect = (detail: Record<string, unknown>, state: Record<string, unknown>) => ({
  type: "effect",
  title: "Tool",
  detail: { display: { summary: "Summary" }, ...detail },
  state,
});

describe("vibeHistoryTurnItem", () => {
  it.each([
    [
      "shell",
      effect(
        { kind: "shell", toolName: "bash", input: { command: "ls -la" } },
        { status: "completed", output: { stdout: "a\nb", stderr: "", exitCode: 0 } },
      ),
      {
        type: "command_execution",
        status: "completed",
        input: "ls -la",
        output: "a\nb",
        exitCode: 0,
      },
    ],
    [
      "streaming shell",
      effect(
        { kind: "shell", toolName: "bash", input: { command: "make" } },
        { status: "running", outputText: "building" },
      ),
      { type: "command_execution", status: "running", output: "building" },
    ],
    [
      "file edit",
      effect(
        {
          kind: "file_edit",
          toolName: "edit",
          input: { filePath: "/repo/a.ts", oldString: "x", newString: "y" },
        },
        { status: "completed" },
      ),
      { type: "file_change", fileName: "/repo/a.ts", oldStr: "x", newStr: "y" },
    ],
    [
      "completed batch edit",
      effect(
        { kind: "file_edit", input: { filePath: "a.ts", changes: [] } },
        {
          status: "completed",
          output: {
            occurrences: [
              { startLine: 2, newStartLine: 2, oldText: "one\n", newText: "one" },
              { startLine: 8, newStartLine: 8, oldText: "two", newText: "second" },
            ],
          },
        },
      ),
      {
        type: "file_change",
        fileName: "a.ts",
        diffStr:
          "@@ -2,1 +2,1 @@\n-one\n+one\n\\ No newline at end of file\n@@ -8,1 +8,1 @@\n-two\n+second\n",
      },
    ],
    [
      "web search with sources",
      effect(
        { kind: "web_search", input: { query: "layout" } },
        {
          status: "completed",
          output: {
            answer: "Results",
            sources: [{ title: "Example", url: "https://example.com" }],
          },
        },
      ),
      {
        type: "web_search",
        patterns: ["layout"],
        results: [{ snippet: "Results" }, { title: "Example", url: "https://example.com" }],
      },
    ],
    [
      "failed web search",
      effect(
        { kind: "web_search", input: { query: "layout" } },
        { status: "failed", error: { message: "Search unavailable" } },
      ),
      { type: "web_search", status: "failed", results: [{ snippet: "Search unavailable" }] },
    ],
    [
      "file write",
      effect(
        { kind: "file_write", toolName: "write", input: { filePath: "/repo/b.ts", content: "z" } },
        { status: "blocked", callbackId: "cb" },
      ),
      { type: "file_change", status: "waiting", fileName: "/repo/b.ts", newStr: "z" },
    ],
    [
      "file overwrite",
      effect(
        { kind: "file_write", input: { filePath: "/repo/b.ts", content: "z" } },
        { status: "completed", output: { previousContent: "" } },
      ),
      { type: "file_change", fileName: "/repo/b.ts", oldStr: "", newStr: "z" },
    ],
    [
      "file search with matches",
      effect(
        { kind: "file_search", input: { pattern: "todo", path: "." } },
        {
          status: "completed",
          output: {
            parsedMatches: [
              { path: "a.ts", line: 12 },
              { path: "b.ts", line: null },
            ],
          },
        },
      ),
      {
        type: "file_search",
        pattern: "todo",
        results: [{ fileName: "a.ts", line: 12 }, { fileName: "b.ts" }],
      },
    ],
    [
      "file search without matches",
      effect(
        { kind: "file_search", input: { pattern: "todo", path: "." } },
        { status: "completed", output: { matches: "", matchCount: 0, parsedMatches: [] } },
      ),
      { type: "file_search", results: [] },
    ],
    [
      "failed generic tool",
      effect(
        { kind: "tool", toolName: "mcp__db__query", input: { sql: "select 1" } },
        { status: "failed", error: { message: "boom" } },
      ),
      {
        type: "dynamic_tool",
        status: "failed",
        toolName: "mcp__db__query",
        input: { sql: "select 1" },
        output: "boom",
        title: "Summary",
      },
    ],
    [
      "Vibe-named MCP tool",
      effect(
        { kind: "tool", toolName: "mcp_t3_code.t3_thread_read", input: { threadId: "t" } },
        { status: "completed", output: "{}" },
      ),
      { type: "dynamic_tool", toolName: "mcp__t3_code__t3_thread_read" },
    ],
    ["reasoning", { type: "reasoning", text: "thinking" }, { type: "reasoning", text: "thinking" }],
  ])("projects %s entries", (_name, entry, expected) => {
    expect(vibeHistoryTurnItem(base, entry)).toMatchObject(expected);
  });

  it("skips entries the timeline does not show", () => {
    expect(vibeHistoryTurnItem(base, { type: "callback", title: "Approve?" })).toBeUndefined();
    expect(vibeHistoryTurnItem(base, { type: "reasoning", text: "" })).toBeUndefined();
  });

  it("settles only terminal effect states", () => {
    expect(vibeEffectSettled({ state: { status: "running" } })).toBe(false);
    expect(vibeEffectSettled({ state: { status: "blocked" } })).toBe(false);
    expect(vibeEffectSettled({ state: { status: "skipped" } })).toBe(true);
  });
});
