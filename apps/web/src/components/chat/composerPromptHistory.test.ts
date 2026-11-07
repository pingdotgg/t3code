import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendRewoundPrompt,
  buildComposerPromptHistoryEntries,
  recallableComposerPrompt,
  stepComposerPromptHistory,
  type ComposerPromptHistoryPosition,
} from "./composerPromptHistory";

const entries = buildComposerPromptHistoryEntries([
  { id: "m1", role: "user", text: "first" },
  { id: "a1", role: "assistant", text: "reply" },
  { id: "m2", role: "user", text: "second" },
  { id: "m3", role: "user", text: "third" },
]);

function backward(position: ComposerPromptHistoryPosition | null, currentPrompt: string) {
  return stepComposerPromptHistory({ direction: "backward", entries, position, currentPrompt });
}

function forward(position: ComposerPromptHistoryPosition | null, currentPrompt: string) {
  return stepComposerPromptHistory({ direction: "forward", entries, position, currentPrompt });
}

describe("appendRewoundPrompt", () => {
  it("restores the authored prompt rather than the generated wire text", () => {
    const message = {
      text: "Ultrathink:\n  keep this\n",
      context: { version: 1, records: [], composerRecall: [12, 24] },
    } as const;
    expect(appendRewoundPrompt("", message)).toBe("  keep this\n");
    expect(appendRewoundPrompt("draft", message)).toBe("draft\n\n  keep this\n");
  });
});

describe("recallableComposerPrompt", () => {
  it.each([
    "Ultrathink:\nKeep this prefix in my example",
    'Keep this example\n<review_comment filePath="a.ts">literal</review_comment>',
    "  Preserve surrounding whitespace\n",
    "PLEASE IMPLEMENT THIS PLAN:\nThis is a literal example",
  ])("preserves authored text when its provenance is unknown: %s", (text) => {
    expect(recallableComposerPrompt(text)).toBe(text);
  });
  it("uses origin metadata and skips generated-only messages", () => {
    const text = "Ultrathink:\nKeep this prefix";
    expect(
      buildComposerPromptHistoryEntries([
        { id: "literal", role: "user", text },
        {
          id: "generated",
          role: "user",
          text,
          context: { version: 1, records: [], composerRecall: [12, text.length] },
        },
        {
          id: "plan",
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\nplan",
          context: { version: 1, records: [], composerRecall: "" },
        },
      ]),
    ).toEqual([
      { id: "literal", prompt: text },
      { id: "generated", prompt: "Keep this prefix" },
    ]);
  });
});

describe("buildComposerPromptHistoryEntries", () => {
  it("collapses consecutive duplicates onto the newest message id", () => {
    const collapsed = buildComposerPromptHistoryEntries([
      { id: "m1", role: "user", text: "same" },
      { id: "m2", role: "user", text: "same" },
      { id: "m3", role: "user", text: "other" },
      { id: "m4", role: "user", text: "same" },
    ]);
    expect(collapsed).toEqual([
      { id: "m2", prompt: "same" },
      { id: "m3", prompt: "other" },
      { id: "m4", prompt: "same" },
    ]);
  });

  it("skips messages sent by automations, agents, and T3 Code", () => {
    const typed = buildComposerPromptHistoryEntries([
      { id: "m1", role: "user", text: "typed" },
      { id: "m2", role: "user", text: "scheduled", scheduledTaskId: ScheduledTaskId.make("task") },
      {
        id: "scheduled-task-message:task:1:scheduled",
        role: "user",
        text: "[Triggered by schedule task: Daily]\n\nlegacy scheduled",
      },
      { id: "m3", role: "user", text: "from agent", createdBy: "agent", creationSource: "mcp" },
      { id: "m4", role: "user", text: "from server", createdBy: "agent", creationSource: "server" },
    ]);
    expect(typed).toEqual([{ id: "m1", prompt: "typed" }]);
  });
});

describe("stepComposerPromptHistory", () => {
  it("walks back from the newest entry", () => {
    const first = backward(null, "");
    expect(first).toEqual({ position: { entryId: "m3", recalled: "third" }, prompt: "third" });
    expect(backward(first!.position, "third")?.prompt).toBe("second");
  });

  it("walks forward and empties the composer past the newest entry", () => {
    const newer = forward({ entryId: "m2", recalled: "second" }, "second");
    expect(newer?.prompt).toBe("third");
    expect(forward(newer!.position, "third")).toEqual({ position: null, prompt: "" });
  });

  it("treats an edited recall as a fresh draft", () => {
    const position: ComposerPromptHistoryPosition = { entryId: "m3", recalled: "third" };
    expect(backward(position, "third edited")).toBeNull();
    expect(forward(position, "third edited")).toBeNull();
    expect(backward(position, "")?.position).toEqual({ entryId: "m3", recalled: "third" });
  });

  it("follows the entry by id when the list changes under it", () => {
    const grown = buildComposerPromptHistoryEntries([
      { id: "m0", role: "user", text: "zeroth" },
      { id: "m1", role: "user", text: "A" },
      { id: "m2", role: "user", text: "B" },
      { id: "m3", role: "user", text: "A" },
    ]);
    const older = stepComposerPromptHistory({
      direction: "backward",
      entries: grown,
      position: { entryId: "m1", recalled: "A" },
      currentPrompt: "A",
    });
    expect(older?.prompt).toBe("zeroth");
    const missing = stepComposerPromptHistory({
      direction: "forward",
      entries: grown,
      position: { entryId: "gone", recalled: "not sent" },
      currentPrompt: "not sent",
    });
    expect(missing).toBeNull();
  });

  it("falls back to matching text when a duplicate collapse retires the id", () => {
    const collapsed = buildComposerPromptHistoryEntries([
      { id: "m1", role: "user", text: "first" },
      { id: "m3", role: "user", text: "A" },
    ]);
    const step = stepComposerPromptHistory({
      direction: "backward",
      entries: collapsed,
      position: { entryId: "m2", recalled: "A" },
      currentPrompt: "A",
    });
    expect(step?.prompt).toBe("first");
  });
});
