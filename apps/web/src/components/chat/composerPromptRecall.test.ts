import { describe, expect, it } from "vite-plus/test";
import {
  createComposerRecall,
  offsetComposerRecall,
  recallComposerText,
} from "@t3tools/shared/composerRecall";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import {
  composeTerminalContextPrompt,
  materializeInlineTerminalContextPrompt,
  buildTerminalContextBlock,
  stripInlineTerminalContextPlaceholders,
} from "../../lib/terminalContext";
import { appendElementContextsToPrompt } from "../../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import { appendReviewCommentsToPrompt, buildFileReviewComment } from "../../reviewCommentContext";
import { buildPlanImplementationPrompt, resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { deriveComposerSendState } from "../ChatView.logic";

import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  buildComposerPromptHistoryEntries,
} from "./composerPromptHistory";

describe("durable composer recall", () => {
  it.each([null, "ultrathink"])(
    "recalls the actual plan-follow-up send with effort %s",
    (effort) => {
      const raw = " \ta\uFFFCb\n    text\uFFFC \n";
      const sendState = deriveComposerSendState({
        prompt: raw,
        imageCount: 0,
        terminalContexts: [],
      });
      const followUp = resolvePlanFollowUpSubmission({
        draftText: sendState.trimmedPrompt,
        planMarkdown: "# Plan",
      });
      const text = applyClaudePromptEffortPrefix(followUp.text, effort);
      expect(followUp.text).toBe("ab\n    text");
      expect(
        recallComposerText({
          text,
          composerRecall: offsetComposerRecall(
            createComposerRecall(stripInlineTerminalContextPlaceholders(raw)),
            text.length - followUp.text.length,
          ),
        }),
      ).toBe(" \tab\n    text \n");
    },
  );
  it.each([
    "Ultrathink:\nKeep this prefix in my example",
    "Example:\n<review_comment>Keep this literal</review_comment>",
    "PLEASE IMPLEMENT THIS PLAN:\nThis is an example, not an action",
  ])("preserves unknown authored text unchanged: %s", (text) => {
    expect(buildComposerPromptHistoryEntries([{ id: "literal", role: "user", text }])).toEqual([
      { id: "literal", prompt: text },
    ]);
  });

  it("distinguishes identical text with recorded different origins", () => {
    const text = "Ultrathink:\nKeep this prefix in my example";
    const messages = [
      { id: "literal", role: "user", text, composerRecall: { ranges: [[0, text.length]] } },
      { id: "generated", role: "user", text, composerRecall: { ranges: [[12, text.length]] } },
    ] as const;
    expect(buildComposerPromptHistoryEntries(messages)).toEqual([
      { id: "literal", prompt: text },
      { id: "generated", prompt: "Keep this prefix in my example" },
    ]);
  });

  it.each([
    ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    buildPlanImplementationPrompt("Implement the example"),
  ])("keeps a typed bootstrap message but skips the same generated message", (text) => {
    expect(
      buildComposerPromptHistoryEntries([
        { id: "authored", role: "user", text, composerRecall: createComposerRecall(text) },
        { id: "generated", role: "user", text, composerRecall: { ranges: [] } },
        { id: "unknown", role: "user", text: `${text}\nlegacy` },
      ]),
    ).toEqual([
      { id: "authored", prompt: text },
      { id: "unknown", prompt: `${text}\nlegacy` },
    ]);
  });

  it.each([
    "  Ultrathink:\nAlready editable\n",
    "  /compact keep recent errors  ",
    "  Ordinary 😀 prompt\n",
  ])("preserves authored text when effort adds no prefix or a known prefix: %j", (raw) => {
    const composed = composeTerminalContextPrompt(raw, []);
    const text = applyClaudePromptEffortPrefix(composed.text, "ultrathink");
    expect(
      recallComposerText({
        text,
        composerRecall: offsetComposerRecall(
          composed.composerRecall,
          text.length - composed.text.length,
        ),
      }),
    ).toBe(raw);
  });

  it("keeps literal labels and markup while excluding actual appended context", () => {
    const raw = "  @terminal-1:4 literal\n<review_comment>example</review_comment>\n\uFFFC done  ";
    const contexts = [
      { terminalId: "default", terminalLabel: "Terminal 1", lineStart: 4, lineEnd: 4, text: "pwd" },
    ];
    const composed = composeTerminalContextPrompt(raw, contexts);
    expect(composed.text).toBe(
      `${materializeInlineTerminalContextPrompt(raw, contexts).trim()}\n\n${buildTerminalContextBlock(contexts)}`,
    );
    const withElement = appendElementContextsToPrompt(composed.text, [
      {
        pageUrl: "https://example.com",
        pageTitle: "Example",
        tagName: "button",
        selector: "button",
        htmlPreview: "<button>Save</button>",
        componentName: null,
        source: null,
        styles: "",
      },
    ]);
    const withPreview = appendPreviewAnnotationPrompt(withElement, {
      id: "preview",
      pageUrl: "https://example.com",
      pageTitle: "Example",
      comment: "Change this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-09-05T00:00:00Z",
    });
    const withReview = appendReviewCommentsToPrompt(withPreview, [
      buildFileReviewComment({
        id: "review",
        filePath: "file.ts",
        startLine: 1,
        endLine: 1,
        text: "Check this",
        contents: "one",
      }),
    ]);
    const text = applyClaudePromptEffortPrefix(withReview, "ultrathink");
    const composerRecall = offsetComposerRecall(
      composed.composerRecall,
      text.length - withReview.length,
    );
    expect(recallComposerText({ text, composerRecall })).toBe(raw.replace("\uFFFC", ""));
    expect(
      buildComposerPromptHistoryEntries([{ id: "sent", role: "user", text, composerRecall }]),
    ).toEqual([{ id: "sent", prompt: raw.replace("\uFFFC", "") }]);
  });
});
