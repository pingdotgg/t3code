import { describe, expect, it } from "vite-plus/test";

import { buildPlanImplementationPrompt } from "../../proposedPlan";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
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

describe("recallableComposerPrompt", () => {
  it.each([
    "Render <preview_annotation>",
    "Render\n<preview_annotation>\nhere",
    "Render &lt;preview_annotation&gt;",
  ])("strips an annotation whose comment contains a literal opening tag: %s", (comment) => {
    expect(
      recallableComposerPrompt(
        `Prompt\n<preview_annotation>\nComment: ${comment}\n</preview_annotation>`,
      ),
    ).toBe("Prompt");
  });

  it("preserves a malformed annotation containing a nested opening tag", () => {
    const text =
      "Prompt\n<preview_annotation>\nouter literal\n<preview_annotation>\ninner\n</preview_annotation>";
    expect(recallableComposerPrompt(text)).toBe(text);
  });
  it("does not strip a terminal label embedded in ordinary prose", () => {
    expect(
      recallableComposerPrompt(
        "email@build:7\n<terminal_context>\n- Build line 7:\n  output\n</terminal_context>",
      ),
    ).toBe("email@build:7");
  });
  it("strips legacy send-time context blocks and the ultrathink prefix", () => {
    const sent =
      "Ultrathink:\nInvestigate this\n\n<terminal_context>\n- Terminal 1 lines 12-13:\n  12 | git status\n  13 | On branch main\n</terminal_context>\n\n<element_context>\n- <button>:\n  url: https://example.com\n</element_context>";
    expect(recallableComposerPrompt(sent)).toBe("Investigate this");
  });

  it.each([
    ["Look at @terminal-1:4 please", "Look at please"],
    [
      "@terminal-1:4 typed twice: @terminal-1:4\n    indented  code",
      "typed twice: @terminal-1:4\n    indented  code",
    ],
    [
      "see @terminal-1:40 and @terminal-1:4-12 then @terminal-1:4",
      "see @terminal-1:40 and @terminal-1:4-12 then",
    ],
  ])("removes only the matching legacy terminal label from %s", (typed, expected) => {
    const sent =
      typed + "\n\n<terminal_context>\n- Terminal 1 line 4:\n  4 | ls\n</terminal_context>";
    expect(recallableComposerPrompt(sent)).toBe(expected);
  });

  it("strips only review comments appended at the end", () => {
    const block = '<review_comment filePath="src/app.ts">Keep this configurable.</review_comment>';
    expect(recallableComposerPrompt("Please update this.\n\n" + block)).toBe("Please update this.");
    const midPrompt = "Before\n\n" + block + "\n\nAfter";
    expect(recallableComposerPrompt(midPrompt)).toBe(midPrompt);
    expect(recallableComposerPrompt(midPrompt + "\n\n" + block)).toBe(midPrompt);
  });

  it("strips a trailing preview annotation including its nested element context", () => {
    const sent =
      "Fix this\n\n<preview_annotation>\nPage: Example\n<element_context>\n- <button>:\n  html: Save\n</element_context>\n</preview_annotation>";
    expect(recallableComposerPrompt(sent)).toBe("Fix this");
  });

  it("removes canonical references without restoring dangling chips", () => {
    const sent =
      "Look at [Terminal](t3-context://v1/terminal/term-1) please\n    indented  code\n![image](t3-context://v1/image/img-1)";
    expect(recallableComposerPrompt(sent)).toBe("Look at please\n    indented  code");
    expect(recallableComposerPrompt("![image](t3-context://v1/image/img-1)")).toBe("");
  });

  it("returns an empty string for app-composed sends", () => {
    expect(recallableComposerPrompt("   ")).toBe("");
    expect(recallableComposerPrompt(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
    expect(recallableComposerPrompt(buildPlanImplementationPrompt("# Plan\n1. do it"))).toBe("");
  });
});

describe("buildComposerPromptHistoryEntries", () => {
  it("keeps user messages with text, oldest first", () => {
    expect(entries.map((entry) => entry.prompt)).toEqual(["first", "second", "third"]);
  });

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
});

describe("stepComposerPromptHistory", () => {
  it("does not start browsing from a non-empty draft", () => {
    expect(backward(null, "typing")).toBeNull();
  });

  it("walks back from the newest entry", () => {
    const first = backward(null, "");
    expect(first).toEqual({ position: { entryId: "m3", recalled: "third" }, prompt: "third" });
    expect(backward(first!.position, "third")?.prompt).toBe("second");
  });

  it("is a no-op at the oldest entry so the caret keeps moving", () => {
    expect(backward({ entryId: "m1", recalled: "first" }, "first")).toBeNull();
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
    // Sent and cleared: ArrowUp starts over from the newest entry.
    expect(backward(position, "")?.position).toEqual({ entryId: "m3", recalled: "third" });
  });

  it("does nothing on forward when not browsing", () => {
    expect(forward(null, "")).toBeNull();
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
    // Unknown id with no matching text: browsing is over.
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
