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
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly payload?: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id),
    tone: "tool",
    kind: overrides.kind,
    summary: overrides.summary,
    payload: overrides.payload ?? {},
    turnId: TurnId.make("turn-1"),
    createdAt: overrides.createdAt,
  };
}

describe("renderProviderHandoffPrelude", () => {
  it("renders prior messages in order and excludes the in-flight message", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [
        message("m1", "user", "hello"),
        message("m2", "assistant", "hi there", "2026-01-01T00:00:01.000Z"),
        message("m3", "system", "internal note", "2026-01-01T00:00:02.000Z"),
        message("m4", "user", "continue with Codex", "2026-01-01T00:00:03.000Z"),
      ],
      excludeMessageId: "m4",
    });

    expect(prelude).toContain("[Conversation handoff]");
    expect(prelude).toContain("User:\nhello");
    expect(prelude).toContain("Assistant:\nhi there");
    expect(prelude).not.toContain("internal note");
    expect(prelude).not.toContain("continue with Codex");
    expect(prelude!.indexOf("hello")).toBeLessThan(prelude!.indexOf("hi there"));
  });

  it("carries completed tool work with output and changed files", () => {
    const prelude = renderProviderHandoffPrelude({
      messages: [message("m1", "user", "inspect and fix it")],
      activities: [
        activity({
          id: "a1",
          kind: "tool.completed",
          summary: "Ran command",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "command_execution",
            data: {
              item: {
                id: "cmd-1",
                command: "vp test run feature.test.ts",
                exitCode: 0,
                aggregatedOutput: "1 passed",
              },
            },
          },
        }),
        activity({
          id: "a2",
          kind: "tool.completed",
          summary: "Edited files",
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: {
            itemType: "file_change",
            data: { item: { id: "edit-1", changes: [{ path: "src/feature.ts" }] } },
          },
        }),
      ],
    });

    expect(prelude).toContain("[$] vp test run feature.test.ts (exit 0)");
    expect(prelude).toContain("1 passed");
    expect(prelude).toContain("[edit] src/feature.ts");
  });

  it("prefers a terminal tool result over a longer streaming update", () => {
    const streamingOutput = "still running ".repeat(40);
    const prelude = renderProviderHandoffPrelude({
      messages: [message("m1", "user", "run it")],
      activities: [
        activity({
          id: "a1",
          kind: "tool.updated",
          summary: "Running",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            itemType: "command_execution",
            data: { item: { id: "cmd-1", command: "flaky", aggregatedOutput: streamingOutput } },
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
              item: { id: "cmd-1", command: "flaky", exitCode: 1, aggregatedOutput: "failed" },
            },
          },
        }),
      ],
    });

    expect(prelude!.match(/\[\$\] flaky/g)).toHaveLength(1);
    expect(prelude).toContain("[$] flaky (exit 1)");
    expect(prelude).toContain("failed");
    expect(prelude).not.toContain(streamingOutput);
  });

  it("keeps the newest complete entries within the character budget", () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(
        `m${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `message ${index} ${"x".repeat(200)}`,
        `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      ),
    );
    const prelude = renderProviderHandoffPrelude({ messages, maxChars: 2_000 });

    expect(prelude).toBeDefined();
    expect(prelude!.length).toBeLessThanOrEqual(2_000);
    expect(prelude).toContain("[Older history omitted for length]");
    expect(prelude).toContain("message 49");
    expect(prelude).not.toContain("message 0 ");
  });
});
