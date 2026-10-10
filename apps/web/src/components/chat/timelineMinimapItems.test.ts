import { describe, expect, it } from "vite-plus/test";
import { MessageId, ScheduledTaskId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<
    readonly [
      "user" | "assistant",
      string,
      Partial<Pick<ChatMessage, "id" | "createdBy" | "creationSource" | "scheduledTaskId">>?,
    ]
  >,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text, metadata], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
    ...metadata,
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("distinguishes automation prompts while retaining every turn's jump target and response", () => {
    const source = rows([
      ["user", "Check manually", { createdBy: "user" }],
      ["assistant", "Manual result"],
      ["user", "Check on schedule", { scheduledTaskId: ScheduledTaskId.make("removed-task") }],
      ["assistant", "Scheduled result"],
      ["user", "Check again", { createdBy: "user" }],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(
      items.map(({ attribution, rowIndex, assistantText }) => ({
        attribution,
        rowIndex,
        assistantText,
      })),
    ).toEqual([
      { attribution: null, rowIndex: 0, assistantText: "Manual result" },
      { attribution: "automation", rowIndex: 2, assistantText: "Scheduled result" },
      { attribution: null, rowIndex: 4, assistantText: null },
    ]);
    expect(items.map((item) => source[item.rowIndex]?.id)).toEqual(items.map((item) => item.id));
    expect(resolveTimelineMinimapPreview(items[1]!)?.attribution).toBe("automation");
  });

  it("recognizes legacy automations without treating a pasted schedule prefix as automation", () => {
    const text = "[Triggered by schedule task: Hourly check]\n\n Check\n status ";
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", text, { id: MessageId.make("scheduled-task-message:hourly:1:scheduled") }],
        ["user", text, { createdBy: "agent" }],
        ["user", text, { createdBy: "user" }],
        ["user", "Follow up", { createdBy: "agent", creationSource: "mcp" }],
        ["user", "Continue", { createdBy: "agent", creationSource: "server" }],
      ]),
    );
    expect(items.map((item) => item.attribution)).toEqual([
      "automation",
      "automation",
      null,
      "agent",
      "t3code",
    ]);
    expect(items[0]?.userText).toBe(" Check\n status ");
    expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBe("Check status");
    expect(items[2]?.userText).toBe(text);
  });

  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
    expect(items[0]?.assistantText).toBe(" Done\t now ");
  });

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    expect(resolveTimelineMinimapPreview(next)).toEqual({
      ...first,
      assistantText: "First second",
    });
    expect(resolveTimelineMinimapPreview(first)?.assistantText).toBe("First");
  });
});
