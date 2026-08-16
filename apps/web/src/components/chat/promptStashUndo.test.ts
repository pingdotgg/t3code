import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  findPromptStashUndoTransaction,
  type PromptStashUndoTransaction,
  undoPromptStashSideEffects,
} from "./promptStashUndo";

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

function makeTransaction(historyEntryId = 1, entryId = "stash-1"): PromptStashUndoTransaction {
  return {
    entryId,
    targetKey: "draft-1",
    historyEntryId,
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

  it("restores a stacked stash even while the newer prompt is still visible", () => {
    const transaction = makeTransaction();
    const takeEntry = vi.fn(() => ({ entry: { id: "stash-1" }, durable: true }));

    const result = undoPromptStashSideEffects({
      transaction,
      currentTargetKey: "draft-1",
      takeEntry,
      restoreImages: vi.fn(),
      createPreviewUrl: () => "blob:fresh-preview",
    });

    expect(result.undone).toBe(true);
    expect(transaction.state).toBe("undone");
    expect(takeEntry).toHaveBeenCalledWith("stash-1");
  });

  it("does not match an unrelated history entry even when the editor is empty", () => {
    const transaction = makeTransaction(10);

    expect(findPromptStashUndoTransaction([transaction], 11)).toBeNull();
    expect(transaction.state).toBe("available");
  });

  it("matches stacked stashes to their own Lexical history entries", () => {
    const first = makeTransaction(10, "stash-1");
    const second = makeTransaction(20, "stash-2");
    const transactions = [first, second];

    expect(findPromptStashUndoTransaction(transactions, 20)).toBe(second);
    second.state = "undone";
    expect(findPromptStashUndoTransaction(transactions, 10)).toBe(first);
  });

  it("does not restore into a different composer target", () => {
    const transaction = makeTransaction();
    const takeEntry = vi.fn();

    const result = undoPromptStashSideEffects({
      transaction,
      currentTargetKey: "draft-2",
      takeEntry,
      restoreImages: vi.fn(),
    });

    expect(result.undone).toBe(false);
    expect(takeEntry).not.toHaveBeenCalled();
  });
});
