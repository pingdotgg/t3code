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

  it("uses Claude ACP stdout instead of repeating the command", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf hello",
        data: {
          kind: "execute",
          command: "printf hello",
          rawOutput: {
            stdout: "hello from claude\n",
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
