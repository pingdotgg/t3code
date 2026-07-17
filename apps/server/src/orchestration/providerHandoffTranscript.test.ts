import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { renderProviderHandoffPrelude } from "./providerHandoffTranscript.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  createdAt: string = NOW,
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function activity(overrides: {
  id: string;
  kind: string;
  summary: string;
  createdAt: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id),
    tone: overrides.tone ?? "tool",
    kind: overrides.kind,
    summary: overrides.summary,
    payload: overrides.payload ?? {},
    turnId: TurnId.make("turn-1"),
    createdAt: overrides.createdAt,
  };
}

describe("renderProviderHandoffPrelude", () => {
  it("renders user and assistant messages in order with role labels", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [
        message("m1", "user", "hello"),
        message("m2", "assistant", "hi there"),
        message("m3", "user", "do the thing"),
      ],
    });
    expect(prelude).toBeDefined();
    expect(prelude).toContain("[Conversation handoff]");
    expect(prelude).toContain("User:\nhello");
    expect(prelude).toContain("Assistant:\nhi there");
    expect(prelude?.indexOf("hello")).toBeLessThan(prelude!.indexOf("hi there"));
    expect(prelude).not.toContain("[Older history omitted for length]");
  });

  it("excludes the in-flight message and skips system/empty messages", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [
        message("m1", "user", "hello"),
        message("m2", "assistant", "hi there"),
        message("m3", "system", "internal note"),
        message("m4", "assistant", "   "),
        message("m5", "user", "current message"),
      ],
      excludeMessageId: "m5",
    });
    expect(prelude).toContain("hello");
    expect(prelude).toContain("hi there");
    expect(prelude).not.toContain("internal note");
    expect(prelude).not.toContain("current message");
  });

  it("returns undefined when there is nothing to hand off", () => {
    expect(renderProviderHandoffPrelude({ messages: [] })).toBeUndefined();
    expect(
      renderProviderHandoffPrelude({
        messages: [message("m1", "user", "only message")],
        excludeMessageId: "m1",
      }),
    ).toBeUndefined();
    expect(
      renderProviderHandoffPrelude({
        messages: [message("m1", "user", "hello")],
        maxChars: 0,
      }),
    ).toBeUndefined();
  });

  it("keeps the most recent messages and flags truncation when over budget", () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(
        `m${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `message ${index} ${"x".repeat(200)}`,
      ),
    );
    const prelude = renderProviderHandoffPrelude({ messages, maxChars: 2_000 });
    expect(prelude).toBeDefined();
    expect(prelude!.length).toBeLessThanOrEqual(2_000);
    expect(prelude).toContain("[Older history omitted for length]");
    expect(prelude).toContain("message 49");
    expect(prelude).not.toContain("message 0 ");
  });

  it("carries a shell command, its exit code, and its output as a structured line", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [
        message("m1", "user", "what is HEAD?", "2026-01-01T00:00:00.000Z"),
        message("m2", "assistant", "let me check", "2026-01-01T00:00:03.000Z"),
      ],
      activities: [
        // Real Codex shape: the command is in `detail`; the output and exit
        // code live in the raw provider item under `data.item`.
        activity({
          id: "a1",
          kind: "tool.completed",
          summary: "Ran command",
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: {
            itemType: "command_execution",
            detail: "git rev-parse HEAD",
            data: {
              item: {
                id: "item-1",
                command: "git rev-parse HEAD",
                exitCode: 0,
                aggregatedOutput: "6e42231cb1da130069cbc694f9da4a185067a81f",
              },
            },
          },
        }),
      ],
    });
    expect(prelude).toBeDefined();
    // Command shown under the "$" tag, with exit code and raw output.
    expect(prelude).toContain("[$] git rev-parse HEAD (exit 0)");
    expect(prelude).toContain("6e42231cb1da130069cbc694f9da4a185067a81f");
    // Ordered by timestamp: user message, then the tool line, then assistant.
    expect(prelude!.indexOf("what is HEAD")).toBeLessThan(prelude!.indexOf("[$] git rev-parse"));
    expect(prelude!.indexOf("[$] git rev-parse")).toBeLessThan(prelude!.indexOf("let me check"));
  });

  it("renders file edits with their touched paths under an 'edit' tag", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [message("m1", "user", "refactor it", "2026-01-01T00:00:00.000Z")],
      activities: [
        activity({
          id: "a1",
          kind: "tool.completed",
          summary: "Edited files",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "file_change",
            title: "Apply patch",
            data: {
              item: {
                id: "edit-1",
                changes: [{ path: "src/foo.ts" }, { path: "src/bar.ts" }],
              },
            },
          },
        }),
      ],
    });
    expect(prelude).toContain("[edit] src/foo.ts, src/bar.ts");
  });

  it("flags a failed command with its non-zero exit code", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [message("m1", "user", "run tests", "2026-01-01T00:00:00.000Z")],
      activities: [
        activity({
          id: "a1",
          kind: "tool.completed",
          summary: "Ran command",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "command_execution",
            detail: "npm test <exited with exit code 1>",
            data: { item: { id: "cmd-1", command: "npm test", aggregatedOutput: "1 failing" } },
          },
        }),
      ],
    });
    expect(prelude).toContain("[$] npm test (exit 1)");
    expect(prelude).toContain("1 failing");
  });

  it("labels an MCP tool call under the 'mcp' tag", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [],
      activities: [
        activity({
          id: "a1",
          kind: "tool.completed",
          summary: "MCP call",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "mcp_tool_call",
            title: "lottie.create",
            data: { item: { id: "mcp-1", aggregatedOutput: "created animation" } },
          },
        }),
      ],
    });
    expect(prelude).toContain("[mcp] lottie.create");
    expect(prelude).toContain("created animation");
  });

  it("keeps only the richest line per tool call and truncates long output", () => {
    const longOutput = "y".repeat(5_000);
    const prelude = renderProviderHandoffPrelude({
      messages: [message("m1", "user", "run it", "2026-01-01T00:00:00.000Z")],
      activities: [
        activity({
          id: "a1",
          kind: "tool.updated",
          summary: "Running",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "command_execution",
            data: { item: { id: "call-1", command: "big-cmd" } },
          },
        }),
        activity({
          id: "a2",
          kind: "tool.completed",
          summary: "Ran command",
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: {
            itemType: "command_execution",
            data: { item: { id: "call-1", command: "big-cmd", aggregatedOutput: longOutput } },
          },
        }),
      ],
    });
    expect(prelude).toBeDefined();
    // Single deduped tool line for call-1, with output truncated.
    expect(prelude!.match(/\[\$\] big-cmd/g)?.length).toBe(1);
    expect(prelude).toContain("[truncated]");
    expect(prelude!.length).toBeLessThan(2_000);
  });

  it("prefers the terminal completed event even when an in-progress update is longer", () => {
    // A verbose `tool.updated` (streaming partial output, no exit code) must not
    // shadow the shorter but authoritative `tool.completed` line that carries
    // the real exit code and final output.
    const verboseStreaming = "z".repeat(400);
    const prelude = renderProviderHandoffPrelude({
      messages: [message("m1", "user", "run it", "2026-01-01T00:00:00.000Z")],
      activities: [
        activity({
          id: "a1",
          kind: "tool.updated",
          summary: "Running",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "command_execution",
            data: { item: { id: "call-1", command: "flaky", aggregatedOutput: verboseStreaming } },
          },
        }),
        activity({
          id: "a2",
          kind: "tool.completed",
          summary: "Ran command",
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: {
            itemType: "command_execution",
            data: {
              item: { id: "call-1", command: "flaky", exitCode: 129, aggregatedOutput: "boom" },
            },
          },
        }),
      ],
    });
    expect(prelude).toBeDefined();
    // Exactly one line for call-1, sourced from the completed event.
    expect(prelude!.match(/\[\$\] flaky/g)?.length).toBe(1);
    expect(prelude).toContain("[$] flaky (exit 129)");
    expect(prelude).toContain("boom");
    expect(prelude).not.toContain(verboseStreaming);
  });

  it("still renders a tool trail when there are no textual messages", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [],
      activities: [
        activity({
          id: "a1",
          kind: "tool.completed",
          summary: "Edited file",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: { title: "Edit src/app.ts" },
        }),
      ],
    });
    expect(prelude).toContain("[tool] Edit src/app.ts");
  });
});
