import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "./session-logic";

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

  it("keeps command output that equals the command text", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("matching-output", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf hello",
        data: {
          command: "printf hello",
          rawOutput: { content: "printf hello" },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf hello",
      detail: "printf hello",
    });
  });

  it("keeps OpenCode detail-only output when it equals the command", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("opencode-detail-output", {
        itemType: "command_execution",
        title: "bash",
        detail: "printf hello",
        data: { command: "printf hello" },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf hello",
      detail: "printf hello",
    });
  });

  it("drops a Claude tool-name detail when there is no output", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-no-output", {
        itemType: "command_execution",
        title: "Command run",
        detail: "Bash: printf hello",
        data: {
          toolName: "Bash",
          command: "printf hello",
        },
      }),
    ]);

    expect(entry?.command).toBe("printf hello");
    expect(entry?.detail).toBeUndefined();
  });

  it("drops a truncated Claude tool-name detail for a long command", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-long-command", {
        itemType: "command_execution",
        title: "Command run",
        detail: `Bash: ${command}`.slice(0, 177) + "...",
        data: {
          toolName: "Bash",
          command,
        },
      }),
    ]);

    expect(entry?.command).toBe(command);
    expect(entry?.detail).toBeUndefined();
  });

  it("drops an ACP command echo when the update omits the tool kind", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("acp-no-kind", {
        itemType: "command_execution",
        title: "Terminal",
        detail: "pnpm test",
        data: {
          toolCallId: "tool-1",
          command: "pnpm test",
        },
      }),
    ]);

    expect(entry?.command).toBe("pnpm test");
    expect(entry?.detail).toBeUndefined();
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
