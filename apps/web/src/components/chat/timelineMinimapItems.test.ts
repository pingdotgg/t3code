import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
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

  it("renders assistant markdown only when resolving a preview and keeps user text literal", () => {
    const userText = "Explain **operators** and [x] in [the docs](https://example.com/docs)";
    const assistantText = [
      "## Operators",
      "Use **either** option from [the docs](https://example.com/docs).",
      "",
      "| Operator | Meaning |",
      "| --- | :---: |",
      "| `a \\| b` | either |",
      "",
      "- [x] Match `**/*.ts` files",
      "",
      "[x] deployment complete",
      "",
      "> Note: ~~old~~ new  ",
      "> Next line",
      "",
      "```sh",
      "# install deps",
      "- **not bold**",
      "const snake_case = a * b;",
      "```",
      "",
      "foo<br>bar",
      "",
      "<div>Critical <em>answer</em></div>",
    ].join("\n");
    const [item] = deriveTimelineMinimapItems(
      rows([
        ["user", userText],
        ["assistant", assistantText],
      ]),
    );

    expect(item).toMatchObject({ userText, assistantText });
    expect(resolveTimelineMinimapPreview(item!)).toEqual({
      ...item,
      userText,
      assistantText:
        "Operators Use either option from the docs. Operator Meaning a | b either Match **/*.ts files [x] deployment complete Note: old new Next line # install deps - **not bold** const snake_case = a * b; foo bar Critical answer",
    });
    expect(item).toMatchObject({ userText, assistantText });
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
