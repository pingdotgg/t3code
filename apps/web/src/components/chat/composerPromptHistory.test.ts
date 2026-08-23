import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
  materializeComposerPromptHistoryAttachments,
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("includes optimistic prompt text and keeps stable message identities", () => {
    expect(
      buildComposerPromptHistoryEntries([
        { id: "assistant-1", role: "assistant", text: "Answer" },
        { id: "user-1", role: "user", text: "First" },
        { id: "user-2", role: "user", text: "First" },
        {
          id: "user-3",
          role: "user",
          text: "Ultrathink:\nSecond",
          promptHistoryText: "Second as typed",
        },
      ]),
    ).toEqual([
      { id: "user-1", prompt: "First", attachments: [] },
      { id: "user-2", prompt: "First", attachments: [] },
      { id: "user-3", prompt: "Second as typed", attachments: [] },
    ]);
  });

  it("keeps image attachments with the sent prompt", () => {
    const attachment = {
      type: "image" as const,
      id: "image-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 128,
      previewUrl: "blob:diagram",
    };

    expect(
      buildComposerPromptHistoryEntries([
        {
          id: "user-with-image",
          role: "user",
          text: "Explain this diagram",
          attachments: [attachment],
        },
      ]),
    ).toEqual([
      {
        id: "user-with-image",
        prompt: "Explain this diagram",
        attachments: [attachment],
      },
    ]);
  });

  it("keeps an image-only message in history", () => {
    expect(
      buildComposerPromptHistoryEntries([
        {
          id: "image-only",
          role: "user",
          text: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
          attachments: [
            {
              type: "image",
              id: "image-only-1",
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 64,
              previewUrl: "blob:photo",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "image-only",
        prompt: "",
        attachments: [
          {
            type: "image",
            id: "image-only-1",
            name: "photo.png",
            mimeType: "image/png",
            sizeBytes: 64,
            previewUrl: "blob:photo",
          },
        ],
      },
    ]);
  });
});

describe("navigateComposerPromptHistory", () => {
  const entries = [
    { id: "first", prompt: "First", attachments: [] },
    { id: "second", prompt: "Second", attachments: [] },
    { id: "third", prompt: "Third", attachments: [] },
  ];

  it("walks backward and restores the unsent draft when walking forward", () => {
    const latest = navigateComposerPromptHistory({
      direction: "backward",
      entries,
      offset: null,
      currentPrompt: "",
      draft: "",
    });
    expect(latest).toEqual({
      entryId: "third",
      offset: 0,
      draft: "",
      draftAttachments: [],
      prompt: "Third",
      attachments: [],
    });

    const older = navigateComposerPromptHistory({
      direction: "backward",
      entries,
      offset: latest?.offset ?? null,
      currentPrompt: latest?.prompt ?? "",
      draft: latest?.draft ?? "",
    });
    expect(older).toEqual({
      entryId: "second",
      offset: 1,
      draft: "",
      draftAttachments: [],
      prompt: "Second",
      attachments: [],
    });

    expect(
      navigateComposerPromptHistory({
        direction: "forward",
        entries,
        offset: 0,
        currentPrompt: "Third",
        draft: "unfinished draft",
      }),
    ).toEqual({
      entryId: null,
      offset: null,
      draft: "",
      draftAttachments: [],
      prompt: "unfinished draft",
      attachments: [],
    });
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

  it("leaves ArrowUp to the editor at the oldest recalled prompt", () => {
    expect(
      navigateComposerPromptHistory({
        direction: "backward",
        entries,
        offset: entries.length - 1,
        currentPrompt: "First",
        draft: "",
      }),
    ).toBeNull();
  });

  it("moves attachments through history and clears them past the newest entry", () => {
    const attachment = {
      type: "image" as const,
      id: "history-image",
      name: "history.png",
      mimeType: "image/png",
      sizeBytes: 32,
      previewUrl: "blob:history",
    };
    const entry = { id: "with-image", prompt: "Look here", attachments: [attachment] };

    const recalled = navigateComposerPromptHistory({
      direction: "backward",
      entries: [entry],
      offset: null,
      currentPrompt: "",
      currentAttachments: [],
      draft: "",
      draftAttachments: [],
    });
    expect(recalled?.attachments).toEqual([attachment]);

    expect(
      navigateComposerPromptHistory({
        direction: "forward",
        entries: [entry],
        offset: recalled?.offset ?? null,
        currentPrompt: recalled?.prompt ?? "",
        currentAttachments: recalled?.attachments ?? [],
        draft: recalled?.draft ?? "",
        draftAttachments: recalled?.draftAttachments ?? [],
      }),
    ).toMatchObject({
      offset: null,
      prompt: "",
      attachments: [],
    });
  });
});

describe("findComposerPromptHistoryOffset", () => {
  it("tracks the recalled message when duplicate prompt text exists", () => {
    const entries = [
      { id: "older-a", prompt: "A", attachments: [] },
      { id: "middle-b", prompt: "B", attachments: [] },
      { id: "newer-a", prompt: "A", attachments: [] },
    ];
    expect(findComposerPromptHistoryOffset(entries, "older-a")).toBe(2);
    expect(findComposerPromptHistoryOffset(entries, "missing")).toBeNull();
  });
});

describe("materializeComposerPromptHistoryAttachments", () => {
  it("creates a fresh preview URL for an in-memory file", async () => {
    const file = new File(["image bytes"], "diagram.png", { type: "image/png" });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recalled");

    await expect(
      materializeComposerPromptHistoryAttachments([
        {
          type: "image",
          id: "image-1",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: "blob:sent",
          file,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        id: "image-1",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: "blob:recalled",
        file,
      },
    ]);
    expect(createObjectUrl).toHaveBeenCalledWith(file);
  });
});
