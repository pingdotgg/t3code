import { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { threadTranscriptMarkdown } from "./threadTranscript.ts";

const THREAD = "thread:markdown";
const decodeRow = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ProjectedTurnItem));

function rows(items: ReadonlyArray<Record<string, unknown>>) {
  return items.map((fields, position) => {
    const id = `item-${position}`;
    return decodeRow({
      position,
      visibility: "local",
      sourceThreadId: THREAD,
      sourceItemId: id,
      item: {
        id,
        threadId: THREAD,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: position,
        status: "completed",
        title: null,
        startedAt: "2026-11-05T10:32:45.000Z",
        completedAt: null,
        updatedAt: "2026-11-05T10:40:00.000Z",
        ...fields,
      },
    });
  });
}

const user = (text: string, attachments: ReadonlyArray<unknown> = []) => ({
  type: "user_message",
  messageId: `message-${text}`,
  inputIntent: "turn_start",
  text,
  attachments,
  createdBy: "user",
  creationSource: "web",
});
const assistant = (text: string, fields: Record<string, unknown> = {}) => ({
  type: "assistant_message",
  messageId: `message-${text}`,
  text,
  streaming: false,
  ...fields,
});

describe("threadTranscriptMarkdown", () => {
  it("keeps the conversation and drops tool work, reasoning, and nested items", () => {
    const markdown = threadTranscriptMarkdown({
      title: "Fix the build",
      items: rows([
        user("Why does the build fail?", [
          {
            type: "file",
            id: "attachment-1",
            name: "build.log",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
        ]),
        { type: "reasoning", text: "Thinking about it", streaming: false },
        assistant("Reading the log."),
        {
          type: "dynamic_tool",
          toolName: "read",
          input: { path: "build.log" },
          output: { text: "error" },
        },
        assistant("Subagent chatter", { parentItemId: "item-3" }),
        assistant("  The lockfile is stale.  "),
        assistant(""),
        user("Thanks"),
      ]),
    });

    expect(markdown).toBe(
      [
        "# Fix the build",
        "",
        "**User** · 2026-11-05 10:32 UTC",
        "",
        "Why does the build fail?",
        "",
        "_Attachments: build.log_",
        "",
        "---",
        "",
        "**Assistant** · 2026-11-05 10:32 UTC",
        "",
        "Reading the log.",
        "",
        "The lockfile is stale.",
        "",
        "---",
        "",
        "**User** · 2026-11-05 10:32 UTC",
        "",
        "Thanks",
        "",
      ].join("\n"),
    );
  });
});
