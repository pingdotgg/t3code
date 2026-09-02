import { describe, expect, it } from "vite-plus/test";

import { appendElementContextsToPrompt } from "../../lib/elementContext";
import {
  appendTerminalContextsToPrompt,
  materializeInlineTerminalContextPrompt,
} from "../../lib/terminalContext";
import { appendReviewCommentsToPrompt, buildFileReviewComment } from "../../reviewCommentContext";
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
  it("strips send-time context blocks and the ultrathink prefix", () => {
    const withTerminal = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 12,
        lineEnd: 13,
        text: "git status\nOn branch main",
      },
    ]);
    const withElement = appendElementContextsToPrompt(withTerminal, [
      {
        pageUrl: "https://example.com",
        pageTitle: "Example",
        tagName: "button",
        selector: "button.submit",
        htmlPreview: "<button>Save</button>",
        componentName: null,
        source: null,
        styles: "",
      },
    ]);
    expect(recallableComposerPrompt(`Ultrathink:\n${withElement}`)).toBe("Investigate this");
  });

  it("removes inline terminal labels along with their trailing block", () => {
    const context = {
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 12,
      lineEnd: 13,
      text: "git status",
    };
    const typed = materializeInlineTerminalContextPrompt("Look at \uFFFC please", [context]);
    expect(typed).toBe("Look at @terminal-1:12-13 please");
    const sent = appendTerminalContextsToPrompt(typed, [context]);
    expect(recallableComposerPrompt(sent)).toBe("Look at please");
  });

  it("strips only the review comments appended at the end", () => {
    const comment = buildFileReviewComment({
      id: "comment-1",
      filePath: "src/app.ts",
      startLine: 2,
      endLine: 3,
      text: "Keep this configurable.",
      contents: "one\ntwo\nthree",
    });
    const sent = appendReviewCommentsToPrompt("Please update this.", [comment]);
    expect(recallableComposerPrompt(sent)).toBe("Please update this.");
    const midPrompt = appendReviewCommentsToPrompt("Before", [comment]) + "\n\nAfter";
    expect(recallableComposerPrompt(midPrompt)).toBe(midPrompt);
  });

  it("returns an empty string for attachment-only sends", () => {
    expect(recallableComposerPrompt("   ")).toBe("");
    expect(recallableComposerPrompt(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
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
