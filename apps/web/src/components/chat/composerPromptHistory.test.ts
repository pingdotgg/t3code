import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  appendElementContextsToPrompt,
  type ElementContextSelection,
} from "../../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import {
  appendTerminalContextsToPrompt,
  type TerminalContextSelection,
} from "../../lib/terminalContext";
import { appendReviewCommentsToPrompt, buildFileReviewComment } from "../../reviewCommentContext";
import {
  buildComposerPromptHistoryEntries,
  findComposerPromptHistoryOffset,
  navigateComposerPromptHistory,
  recallableComposerPrompt,
} from "./composerPromptHistory";

const terminalContext: TerminalContextSelection = {
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 2,
  text: "git status\nOn branch main",
};

const elementContext: ElementContextSelection = {
  pageUrl: "https://example.com",
  pageTitle: "Example",
  tagName: "button",
  selector: "button.submit",
  htmlPreview: "<button>Save</button>",
  componentName: "SubmitButton",
  source: null,
  styles: "display: block;",
};

const previewAnnotation: PreviewAnnotationPayload = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Move the button.",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-08-22T12:00:00.000Z",
};

describe("recallableComposerPrompt", () => {
  it("removes send-only payloads from a stored user message", () => {
    let message = appendTerminalContextsToPrompt("Fix the submit button", [terminalContext]);
    message = appendElementContextsToPrompt(message, [elementContext]);
    message = appendPreviewAnnotationPrompt(message, previewAnnotation);
    message = appendReviewCommentsToPrompt(message, [
      buildFileReviewComment({
        id: "comment-1",
        filePath: "src/button.tsx",
        startLine: 1,
        endLine: 1,
        text: "Keep this configurable.",
        contents: "export const Button = () => null;",
      }),
    ]);
    message = applyClaudePromptEffortPrefix(message, "ultrathink");

    expect(recallableComposerPrompt(message)).toBe("Fix the submit button");
  });

  it("does not expose the synthetic image-only prompt", () => {
    expect(
      recallableComposerPrompt(
        "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
      ),
    ).toBe("");
  });
});

describe("buildComposerPromptHistoryEntries", () => {
  it("includes optimistic prompt text and collapses consecutive duplicates", () => {
    expect(
      buildComposerPromptHistoryEntries([
        { role: "assistant", text: "Answer" },
        { role: "user", text: "First" },
        { role: "user", text: "First" },
        {
          role: "user",
          text: "Ultrathink:\nSecond",
          promptHistoryText: "Second as typed",
        },
      ]),
    ).toEqual(["First", "Second as typed"]);
  });
});

describe("navigateComposerPromptHistory", () => {
  const entries = ["First", "Second", "Third"];

  it("walks backward and restores the unsent draft when walking forward", () => {
    const latest = navigateComposerPromptHistory({
      direction: "backward",
      entries,
      offset: null,
      currentPrompt: "",
      draft: "",
    });
    expect(latest).toEqual({ offset: 0, draft: "", prompt: "Third" });

    const older = navigateComposerPromptHistory({
      direction: "backward",
      entries,
      offset: latest?.offset ?? null,
      currentPrompt: latest?.prompt ?? "",
      draft: latest?.draft ?? "",
    });
    expect(older).toEqual({ offset: 1, draft: "", prompt: "Second" });

    expect(
      navigateComposerPromptHistory({
        direction: "forward",
        entries,
        offset: 0,
        currentPrompt: "Third",
        draft: "unfinished draft",
      }),
    ).toEqual({ offset: null, draft: "", prompt: "unfinished draft" });
  });

  it("does not enter history when the composer contains text", () => {
    expect(
      navigateComposerPromptHistory({
        direction: "backward",
        entries,
        offset: null,
        currentPrompt: "keep editing",
        draft: "",
      }),
    ).toBeNull();
  });
});

describe("findComposerPromptHistoryOffset", () => {
  it("signals when a recalled entry disappears from a refreshed timeline", () => {
    expect(findComposerPromptHistoryOffset(["First", "Third"], "Second")).toBeNull();
    expect(findComposerPromptHistoryOffset(["First", "Second", "Third"], "Second")).toBe(1);
  });
});
