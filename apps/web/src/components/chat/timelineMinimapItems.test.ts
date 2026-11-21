import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";

describe("deriveTimelineMinimapItems", () => {
  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("image-only"),
            role: "user",
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
      expect(items).toEqual([{ id: "image-only", rowIndex: 0, userText: "", assistantText: null }]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
    expect(
      resolveTimelineMinimapPreview({
        id: "turn-2",
        rowIndex: 0,
        userText: null,
        assistantText: "1~3月的数据不完整，建议使用4~9月的数据进行对比。 ~~删除~~",
      })?.assistantText,
    ).toBe("1~3月的数据不完整，建议使用4~9月的数据进行对比。 删除");
  });

  it("previews a quote, a context chip and a file link in the user's message as their text", () => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("assistant-1"),
      text: "The cache misses on a cold start.",
      start: 0,
      end: 33,
      prefix: "",
      suffix: "",
    });
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: `${quote}\nWhere do ${file} and [math.ts](src/math.ts) cover this?`,
      assistantText: null,
    });
    expect(preview?.userText).toBe(
      "The cache misses on a cold start. Where do README.md and math.ts cover this?",
    );
  });
});
