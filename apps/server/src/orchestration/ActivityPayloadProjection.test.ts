import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";
import * as Schema from "effect/Schema";
import { ProjectionThreadActivity } from "../persistence/Services/ProjectionThreadActivities.ts";
import { projectSharedTools } from "../sharing/http.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it.each([
    [
      "codex",
      { item: { tool: "terminal", command: "echo input", aggregatedOutput: "private result" } },
    ],
    [
      "codex dynamic tool",
      {
        item: {
          tool: "lookup",
          arguments: "echo input",
          contentItems: [{ type: "inputText", text: "private result" }],
        },
      },
    ],
    ["codex web search", { item: { query: "echo input", results: [{ title: "private result" }] } }],
    [
      "codex collaboration",
      { item: { prompt: "echo input", agentsStates: { agent: { message: "private result" } } } },
    ],
    [
      "claude",
      { toolName: "Bash", input: { command: "echo input" }, result: { content: "private result" } },
    ],
    [
      "opencode",
      { tool: "bash", state: { input: { command: "echo input" }, output: "private result" } },
    ],
    ["cursor", { rawInput: { command: "echo input" }, rawOutput: "private result" }],
    [
      "grok",
      { rawInput: { command: "echo input" }, content: [{ type: "text", text: "private result" }] },
    ],
    [
      "antigravity",
      { rawInput: { command: "echo input" }, rawOutput: { content: "private result" } },
    ],
  ])("shares %s tool input and results only when selected", (_provider, data) => {
    const source = Schema.decodeUnknownSync(ProjectionThreadActivity)({
      activityId: "activity-share",
      threadId: "thread-share",
      turnId: null,
      tone: "tool",
      kind: "tool.completed",
      summary: "private result must not leak through the summary",
      payload: {
        itemType: "command_execution",
        detail: "private result",
        title: "private result must not leak through the title",
        status: "failed",
        toolSurface: "computer",
        data,
        privateMetadata: "never-share",
      },
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    expect(
      projectSharedTools([source], {
        includeToolCalls: false,
        includeToolResults: false,
        includePlans: false,
      }),
    ).toEqual([]);
    const resultsOnly = projectSharedTools([source], {
      includeToolCalls: false,
      includeToolResults: true,
      includePlans: false,
    });
    expect(resultsOnly[0]).not.toHaveProperty("input");
    expect(resultsOnly[0]).not.toHaveProperty("toolSurface");
    expect(resultsOnly[0]).not.toHaveProperty("title");
    expect(resultsOnly[0]).not.toHaveProperty("detail");
    expect(resultsOnly[0]).toMatchObject({ itemType: "command_execution", status: "failed" });
    expect(resultsOnly[0]?.result).toContain("private result");
    expect(JSON.stringify(resultsOnly)).not.toContain("echo input");
    const calls = projectSharedTools([source], {
      includeToolCalls: true,
      includeToolResults: false,
      includePlans: false,
    });
    expect(calls[0]?.input).toContain("echo input");
    expect(calls[0]).not.toHaveProperty("result");
    expect(calls[0]).not.toHaveProperty("status");
    expect(calls[0]).not.toHaveProperty("title");
    expect(calls[0]).not.toHaveProperty("detail");
    expect(calls[0]).toMatchObject({ itemType: "command_execution", toolSurface: "computer" });
    expect(JSON.stringify(calls)).not.toContain("private result");
    const results = projectSharedTools([source], {
      includeToolCalls: true,
      includeToolResults: true,
      includePlans: false,
    });
    expect(results[0]?.result).toContain("private result");
    expect(results[0]).toMatchObject({
      title: "private result must not leak through the title",
      detail: "private result",
    });
    expect(JSON.stringify(results)).not.toContain(
      "private result must not leak through the summary",
    );
    expect(JSON.stringify(results)).not.toContain("never-share");
  });

  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps preview normalization and fence-only fallback while scanning lines", () => {
    const preview = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: `\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}` },
      }),
    );
    const fences = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: "```\r\n \t \n```\n" },
      }),
    );

    expect((preview.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "actual result",
    });
    expect((fences.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "2 lines",
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude command input and result summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "tests passed" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: {
        toolName: "Bash",
        command: "vp test run",
        rawOutput: { content: "tests passed" },
      },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(250);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it.each([
    {
      item: {
        server: "t3-code",
        tool: "preview_open",
        result: { structuredContent: { url: "https://example.com/" } },
      },
    },
    {
      toolName: "mcp__t3-code__preview_navigate",
      result: { content: '{"url":"https://example.com/"}' },
    },
    { tool: "t3-code_preview_status", state: { output: '{"url":"https://example.com/"}' } },
    {
      toolName: "mcp__t3_code__preview_snapshot",
      result: {
        content: [
          { type: "text", text: '{"url":"https://example.com/"}' },
          { type: "text", text: "Snapshot text was bounded. Omitted: accessibilityTree." },
        ],
      },
    },
    {
      toolName: "mcp__t3-code__preview_click",
      result: { content: '{"toolIcon":{"_tag":"website","pageUrl":"https://example.com/"}}' },
    },
    {
      toolName: "mcp__t3_code__preview_snapshot",
      result: { content: '{"url":"https://example.com/"}\n{"accessibilityTree":"truncated' },
    },
    ...[false, true].map((truncated) => ({
      toolName: "mcp__t3_code__preview_snapshot",
      result: {
        content: JSON.stringify({
          content: [{ type: "text", text: '{"url":"https://example.com/"}' }],
          structuredContent: { url: "https://example.com/", visibleText: "page" },
        }).slice(0, truncated ? -5 : undefined),
      },
    })),
    ...[
      "type",
      "press",
      "scroll",
      "resize",
      "set_appearance",
      "evaluate",
      "wait_for",
      "recording_start",
      "recording_stop",
    ].map((action) => ({
      toolName: `mcp__t3_code__preview_${action}`,
      result: { content: '{"toolIcon":{"_tag":"website","pageUrl":"https://example.com/"}}' },
    })),
  ])("preserves the preview page favicon through result slimming", (data) => {
    const projected = projectActivityPayload(activity({ itemType: "mcp_tool_call", data }));
    const icon = { _tag: "website", pageUrl: "https://example.com/" };
    expect(projected.payload).toMatchObject({ toolIcon: icon });
    expect(projectActivityPayload(projected).payload).toMatchObject({ toolIcon: icon });
  });

  it.each([
    { toolName: "mcp__other__preview_open", result: { content: '{"url":"https://example.com/"}' } },
    {
      toolName: "mcp__t3-code__preview_evaluate",
      result: { content: '{"url":"https://example.com/"}' },
    },
    {
      toolName: "mcp__t3-code__preview_open",
      result: { isError: true, content: '{"url":"https://example.com/"}' },
    },
    { toolName: "mcp__t3-code__preview_open", result: { content: "malformed JSON" } },
    { toolName: "mcp__t3-code__preview_open", result: { content: '{"url":"about:blank"}' } },
  ])("keeps the fallback for unrelated tools, failed navigation, and missing page URLs", (data) => {
    expect(
      projectActivityPayload(activity({ itemType: "mcp_tool_call", data })).payload,
    ).not.toHaveProperty("toolIcon");
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});
