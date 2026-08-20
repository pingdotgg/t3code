import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "./session-logic";

function makeCommandActivity(
  id: string,
  payload: Record<string, unknown>,
  overrides: Partial<Pick<OrchestrationThreadActivity, "kind" | "createdAt" | "summary">> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt: "2026-07-17T10:00:00.000Z",
    kind: "tool.completed",
    summary: "Ran command",
    tone: "tool",
    payload,
    turnId: TurnId.make("turn-1"),
    ...overrides,
  };
}

// Claude puts the command in `detail` with a `Bash: ` prefix. The server
// projects `data.command` onto in-progress updates and keeps
// `data.input.command` on the completed activity.
function makeClaudeBashLifecycle(command: string, detail: string): OrchestrationThreadActivity[] {
  const toolCallId = "toolu_01XghhMudoHnUpdrKNfqgcYW";
  return [
    makeCommandActivity(
      "claude-updated",
      {
        itemType: "command_execution",
        toolCallId,
        status: "inProgress",
        detail,
        data: { command },
      },
      { kind: "tool.updated", createdAt: "2026-07-17T10:00:00.000Z", summary: "Command run" },
    ),
    makeCommandActivity(
      "claude-completed",
      {
        itemType: "command_execution",
        toolCallId,
        status: "completed",
        detail,
        data: {
          toolName: "Bash",
          input: { command, description: "List files" },
          result: { type: "tool_result", content: "", is_error: false },
        },
      },
      { kind: "tool.completed", createdAt: "2026-07-17T10:00:01.000Z", summary: "Command run" },
    ),
  ];
}

describe("deriveWorkLogEntries Claude command detail", () => {
  it("drops the tool-name-prefixed detail that repeats the command", () => {
    const command = "cd /repo && grep -n -E \"F0[0-9][0-9]\" TRACKER.md | sed -n '1,120p'";
    const entries = deriveWorkLogEntries(makeClaudeBashLifecycle(command, `Bash: ${command}`));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe(command);
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("drops the detail when the server truncated it", () => {
    const command = `cd /repo && ${"x".repeat(200)} && ls`;
    const detail = `Bash: ${command}`.slice(0, 177) + "...";
    const entries = deriveWorkLogEntries(makeClaudeBashLifecycle(command, detail));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe(command);
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("reads the command from Claude's completed payload", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-only-completed", {
        itemType: "command_execution",
        detail: "Bash: bun test",
        data: { toolName: "Bash", input: { command: "bun test" } },
      }),
    ]);

    expect(entry?.command).toBe("bun test");
    expect(entry?.detail).toBeUndefined();
  });
});

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
