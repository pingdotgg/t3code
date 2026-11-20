import {
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import { startComposerDraftOperation } from "./composerDraftOperations";
import { changeQuestionAttachmentPreparation } from "./question-attachments";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  releaseUnusedComposerAttachmentFiles,
} from "./use-composer-drafts";

const imagePreparations = new Map<string, Set<(threadKey: string | null) => void>>();

/** A paste or accepted picker selection can finish in the thread draft. */
export function startQuestionImagePreparation(key: string, waitingForSelection = false) {
  let destination: string | null = key;
  let threadOperation: ReturnType<typeof startComposerDraftOperation> | undefined;
  const resolve = (threadKey: string | null) => {
    destination = waitingForSelection ? null : threadKey;
    if (destination !== null) threadOperation = startComposerDraftOperation(destination);
  };
  const pending = imagePreparations.get(key) ?? new Set();
  pending.add(resolve);
  imagePreparations.set(key, pending);
  changeQuestionAttachmentPreparation(key, 1);
  const currentDestination = () => (threadOperation?.signal.aborted ? null : destination);
  return {
    acceptSelection: () => {
      if (destination !== key) return false;
      waitingForSelection = false;
      return true;
    },
    destination: currentDestination,
    complete: async (
      result: { attachments: ReadonlyArray<DraftComposerAttachment>; error: string | null },
      scope: QuestionAttachmentScope,
    ) => {
      const target = currentDestination();
      if (target === null || (target === key && !scope.isActive())) {
        await releaseUnusedComposerAttachmentFiles(result.attachments);
        return { error: null, rejected: 0 };
      }
      const rejected =
        target === key
          ? scope.append(result.attachments)
          : appendUnsentQuestionAttachments(target, result.attachments);
      return { error: result.error, rejected };
    },
    finish: () => {
      threadOperation?.finish();
      if (imagePreparations.get(key) !== pending || !pending.delete(resolve)) return;
      if (pending.size === 0) imagePreparations.delete(key);
      changeQuestionAttachmentPreparation(key, -1);
    },
  };
}

export function resolveQuestionImagePreparations(key: string, threadKey: string | null): void {
  const pending = imagePreparations.get(key);
  imagePreparations.delete(key);
  for (const resolve of pending ?? []) resolve(threadKey);
}

export function appendUnsentQuestionAttachments(
  threadKey: string,
  attachments: Parameters<typeof appendComposerDraftAttachments>[1],
): number {
  const { text } = getComposerDraftSnapshot(threadKey);
  // Chips go after the draft's text, never over a selection the user left in it.
  return appendComposerDraftAttachments(threadKey, attachments, {
    appendReference: true,
    insertion: { text, start: text.length, end: text.length },
  });
}

interface QuestionAttachmentScope {
  readonly isActive: () => boolean;
  readonly append: (attachments: ReadonlyArray<DraftComposerAttachment>) => number;
}

export async function pickQuestionAttachments(
  input: QuestionAttachmentScope & {
    readonly key: string;
    readonly kind: "library" | "camera" | "files";
    readonly maxUploadBytes?: number | undefined;
  },
): Promise<{ error: string | null; rejected: number }> {
  const preparation = startQuestionImagePreparation(input.key, true);
  try {
    const existingCount = getComposerDraftSnapshot(input.key).attachments.length;
    const acceptSelection = () => input.isActive() && preparation.acceptSelection();
    const result =
      input.kind === "files"
        ? await pickComposerFiles({
            existingCount,
            maxBytes: input.maxUploadBytes,
            acceptSelection,
          })
        : await pickComposerMedia({
            existingCount,
            maxVideoBytes: input.maxUploadBytes,
            acceptSelection,
            source: input.kind,
          });
    const attachments = "files" in result ? result.files : result.attachments;
    return await preparation.complete({ attachments, error: result.error }, input);
  } finally {
    preparation.finish();
  }
}
