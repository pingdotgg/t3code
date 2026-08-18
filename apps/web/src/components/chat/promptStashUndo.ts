import type { ComposerImageAttachment } from "../../composerDraftStore";

export interface PromptStashUndoTransaction {
  entryId: string;
  targetKey: string;
  historyEntryId: number | null;
  images: ReadonlyArray<ComposerImageAttachment>;
  state: "available" | "undone" | "consumed";
}

type TakeStashEntryResult = {
  entry: unknown | null;
  durable: boolean;
};

function imageDedupKey(image: ComposerImageAttachment): string {
  return `${image.mimeType}\0${image.sizeBytes}\0${image.name}`;
}

/** Appends restored stash images without replacing newer attachments. */
export function mergePromptStashUndoImages(options: {
  currentImages: ReadonlyArray<ComposerImageAttachment>;
  restoredImages: ReadonlyArray<ComposerImageAttachment>;
  maxImages: number;
}): {
  images: ComposerImageAttachment[];
  addedImages: ComposerImageAttachment[];
  unusedImages: ComposerImageAttachment[];
  overflowImageNames: string[];
} {
  const images = [...options.currentImages];
  const addedImages: ComposerImageAttachment[] = [];
  const unusedImages: ComposerImageAttachment[] = [];
  const overflowImageNames: string[] = [];
  const ids = new Set(images.map((image) => image.id));
  const dedupKeys = new Set(images.map(imageDedupKey));

  for (const image of options.restoredImages) {
    const dedupKey = imageDedupKey(image);
    if (ids.has(image.id) || dedupKeys.has(dedupKey)) {
      unusedImages.push(image);
      continue;
    }
    if (images.length >= options.maxImages) {
      unusedImages.push(image);
      overflowImageNames.push(image.name);
      continue;
    }
    ids.add(image.id);
    dedupKeys.add(dedupKey);
    images.push(image);
    addedImages.push(image);
  }

  return { images, addedImages, unusedImages, overflowImageNames };
}

/** Finds the stash side effect attached to Lexical's next history entry. */
export function findPromptStashUndoTransaction(
  transactions: ReadonlyArray<PromptStashUndoTransaction>,
  historyEntryId: number | null,
): PromptStashUndoTransaction | null {
  if (historyEntryId === null) return null;
  for (let index = transactions.length - 1; index >= 0; index -= 1) {
    const transaction = transactions[index];
    if (transaction?.state === "available" && transaction.historyEntryId === historyEntryId) {
      return transaction;
    }
  }
  return null;
}

/**
 * Reverses the non-editor half of a prompt stash while Lexical handles its
 * own text undo. Keeping those responsibilities on the same undo command
 * makes text, images, and the stash queue move as one user action.
 */
export function undoPromptStashSideEffects(options: {
  transaction: PromptStashUndoTransaction | null;
  currentTargetKey: string;
  takeEntry: (entryId: string) => TakeStashEntryResult;
  restoreImages: (images: ComposerImageAttachment[]) => void;
  createPreviewUrl?: (file: File) => string;
}): { undone: boolean; durable: boolean } {
  const transaction = options.transaction;
  if (
    !transaction ||
    transaction.state !== "available" ||
    transaction.targetKey !== options.currentTargetKey
  ) {
    return { undone: false, durable: true };
  }

  const { entry, durable } = options.takeEntry(transaction.entryId);
  if (!entry) {
    transaction.state = "consumed";
    return { undone: false, durable };
  }

  transaction.state = "undone";
  const createPreviewUrl = options.createPreviewUrl ?? URL.createObjectURL;
  options.restoreImages(
    transaction.images.map((image) => ({
      ...image,
      // Stashing revokes the composer's old blob URLs when it clears the
      // attachments. The File snapshots remain valid, so give each restored
      // image a fresh preview URL instead of reviving a revoked one.
      previewUrl: createPreviewUrl(image.file),
    })),
  );
  return { undone: true, durable };
}
