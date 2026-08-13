import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "../../lib/terminalContext";
import { type PromptStashUndoTransaction, undoPromptStashSideEffects } from "./promptStashUndo";

function makeImage(): ComposerImageAttachment {
  return {
    type: "image",
    id: "image-1",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 4,
    previewUrl: "blob:revoked-preview",
    file: { name: "screenshot.png" } as File,
  };
}

function makeTransaction(): PromptStashUndoTransaction {
  return {
    entryId: "stash-1",
    targetKey: "draft-1",
    images: [makeImage()],
    state: "available",
  };
}

describe("undoPromptStashSideEffects", () => {
  it("removes the stash entry and restores images with fresh preview URLs", () => {
    const transaction = makeTransaction();
    const takeEntry = vi.fn(() => ({ entry: { id: "stash-1" }, durable: false }));
    const restoreImages = vi.fn();

    const result = undoPromptStashSideEffects({
      transaction,
      currentTargetKey: "draft-1",
      currentPrompt: "",
      currentImages: [],
      takeEntry,
      restoreImages,
      createPreviewUrl: () => "blob:fresh-preview",
    });

    expect(result).toEqual({ undone: true, durable: false });
    expect(transaction.state).toBe("undone");
    expect(takeEntry).toHaveBeenCalledWith("stash-1");
    expect(restoreImages).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "image-1",
        previewUrl: "blob:fresh-preview",
      }),
    ]);
  });

  it("treats preserved terminal-context placeholders as an empty post-stash editor", () => {
    const transaction = makeTransaction();

    const result = undoPromptStashSideEffects({
      transaction,
      currentTargetKey: "draft-1",
      currentPrompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
      currentImages: [],
      takeEntry: () => ({ entry: { id: "stash-1" }, durable: true }),
      restoreImages: vi.fn(),
      createPreviewUrl: () => "blob:fresh-preview",
    });

    expect(result.undone).toBe(true);
  });

  it("leaves the stash alone until newer editor text has been undone", () => {
    const transaction = makeTransaction();
    const takeEntry = vi.fn();

    const result = undoPromptStashSideEffects({
      transaction,
      currentTargetKey: "draft-1",
      currentPrompt: "newer text",
      currentImages: [],
      takeEntry,
      restoreImages: vi.fn(),
    });

    expect(result.undone).toBe(false);
    expect(transaction.state).toBe("available");
    expect(takeEntry).not.toHaveBeenCalled();
  });

  it("does not restore into a different composer target", () => {
    const transaction = makeTransaction();
    const takeEntry = vi.fn();

    const result = undoPromptStashSideEffects({
      transaction,
      currentTargetKey: "draft-2",
      currentPrompt: "",
      currentImages: [],
      takeEntry,
      restoreImages: vi.fn(),
    });

    expect(result.undone).toBe(false);
    expect(takeEntry).not.toHaveBeenCalled();
  });
});
