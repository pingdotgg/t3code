import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries, selectWorkLogToolOutput } from "./session-logic";

function makeCommandActivity(
  id: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt: "2026-07-17T10:00:00.000Z",
    kind: "tool.completed",
    summary: "Ran command",
    tone: "tool",
    payload,
    turnId: TurnId.make("turn-1"),
  };
}

describe("deriveWorkLogEntries command output", () => {
  it("uses Codex aggregated output instead of repeating the command", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("codex-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "/bin/zsh -lc \"printf 'hello\\n'\"",
        data: {
          item: {
            type: "commandExecution",
            command: "/bin/zsh -lc \"printf 'hello\\n'\"",
            commandActions: [{ command: "printf 'hello\\n'", type: "unknown" }],
            aggregatedOutput: "hello\n<exited with exit code 0>",
            status: "completed",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf 'hello\\n'",
      rawCommand: "/bin/zsh -lc \"printf 'hello\\n'\"",
      detail: "hello",
    });
  });

  it("uses a projected Claude output summary instead of repeating the command", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf hello",
        data: {
          kind: "execute",
          command: "printf hello",
          rawOutput: {
            content: "hello from claude",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf hello",
      detail: "hello from claude",
    });
  });

  it("passes persisted Claude Bash result content through as output, not the short detail", () => {
    const output = `first line of stdout\n${"x".repeat(200)}`;
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-bash-result", {
        itemType: "command_execution",
        title: "Command run",
        detail: "Bash: printf hello && cat huge.txt",
        data: {
          toolName: "Bash",
          input: { command: "printf hello && cat huge.txt" },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: output,
            is_error: false,
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf hello && cat huge.txt",
      detail: "Bash: printf hello && cat huge.txt",
      output,
    });
    expect(selectWorkLogToolOutput(entry!)).toBe(output);
    expect(selectWorkLogToolOutput({ detail: entry!.detail, command: entry!.command })).toBeNull();
  });

  it("keeps a trailing <exited with exit code 0> line in persisted output", () => {
    const output = "hello\n<exited with exit code 0>";
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-bash-exit-line", {
        itemType: "command_execution",
        title: "Command run",
        detail: "Bash: printf hello",
        data: {
          toolName: "Bash",
          input: { command: "printf hello" },
          result: {
            type: "tool_result",
            content: output,
            is_error: false,
          },
        },
      }),
    ]);

    expect(entry?.output).toBe(output);
    expect(selectWorkLogToolOutput(entry!)).toBe(output);
  });

  it("does not copy MCP summarized result onto output", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("mcp-result", {
        itemType: "mcp_tool_call",
        title: "Call repository tool",
        detail: "repository.search",
        data: {
          item: {
            server: "repository",
            tool: "search",
            arguments: { query: "work log" },
            result: { content: "first line of output" },
          },
        },
      }),
    ]);

    expect(entry?.output).toBeUndefined();
    expect(entry?.toolData).toEqual({
      server: "repository",
      tool: "search",
      arguments: { query: "work log" },
      result: { content: "first line of output" },
    });
  });

  it("reads Claude tool_result content blocks as output", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-bash-blocks", {
        itemType: "command_execution",
        title: "Command run",
        detail: "Bash: ls",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          result: {
            type: "tool_result",
            content: [{ type: "text", text: "README.md\npackage.json" }],
            is_error: false,
          },
        },
      }),
    ]);

    expect(selectWorkLogToolOutput(entry!)).toBe("README.md\npackage.json");
  });

  it("drops duplicated command detail when the command has no output", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("empty-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "true",
        data: {
          kind: "execute",
          command: "true",
        },
      }),
    ]);

    expect(entry?.command).toBe("true");
    expect(entry?.detail).toBeUndefined();
  });
});
