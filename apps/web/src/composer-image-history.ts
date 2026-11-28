import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Step, StepMap, StepResult } from "@tiptap/pm/transform";

import type { ComposerImageAttachment } from "./composerDraftStore";

export type ComposerImageHistoryDirection = "add" | "remove";

export interface RetainedComposerImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly file: File;
  readonly source?: ComposerImageAttachment["source"];
  readonly index: number;
}

export interface ComposerImageHistoryChange {
  readonly kind: ComposerImageHistoryDirection;
  readonly targetKey: string;
  readonly images: ReadonlyArray<RetainedComposerImage>;
}

export function toRetainedComposerImage(
  image: ComposerImageAttachment,
  index: number,
): RetainedComposerImage {
  return {
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    file: image.file,
    ...(image.source ? { source: image.source } : {}),
    index,
  };
}

export function restoreRetainedComposerImage(
  retained: RetainedComposerImage,
): ComposerImageAttachment {
  return {
    type: "image",
    id: retained.id,
    name: retained.name,
    mimeType: retained.mimeType,
    sizeBytes: retained.sizeBytes,
    previewUrl: URL.createObjectURL(retained.file),
    file: retained.file,
    ...(retained.source ? { source: retained.source } : {}),
  };
}

/**
 * Document-preserving ProseMirror step that puts draft image adds/removals on the
 * editor's undo/redo timeline and ties retained File lifetime to ProseMirror history.
 */
export class ComposerImageHistoryStep extends Step {
  readonly kind: ComposerImageHistoryDirection;
  readonly targetKey: string;
  readonly images: ReadonlyArray<RetainedComposerImage>;

  constructor(
    kind: ComposerImageHistoryDirection,
    targetKey: string,
    images: ReadonlyArray<RetainedComposerImage>,
  ) {
    super();
    this.kind = kind;
    this.targetKey = targetKey;
    this.images = [...images];
  }

  override apply(doc: ProseMirrorNode): StepResult {
    return StepResult.ok(doc);
  }

  override invert(): Step {
    return new ComposerImageHistoryStep(
      this.kind === "add" ? "remove" : "add",
      this.targetKey,
      this.images,
    );
  }

  override getMap(): StepMap {
    return StepMap.empty;
  }

  override map(): Step {
    return this;
  }

  override merge(): Step | null {
    return null;
  }

  override toJSON() {
    return {
      stepType: "composer-image-history",
      kind: this.kind,
      targetKey: this.targetKey,
      imageIds: this.images.map((image) => image.id),
    };
  }
}

export function extractComposerImageHistoryChanges(
  transactions: ReadonlyArray<Transaction>,
): ComposerImageHistoryChange[] {
  const changes: ComposerImageHistoryChange[] = [];
  for (const tr of transactions) {
    for (const step of tr.steps) {
      if (step instanceof ComposerImageHistoryStep && step.images.length > 0) {
        changes.push({
          kind: step.kind,
          targetKey: step.targetKey,
          images: step.images,
        });
      }
    }
  }
  return changes;
}

/**
 * Computes non-overlapping Markdown offset ranges to delete when removing every
 * inline reference to `contextId`, matching `removeInlineContextReference` spacing
 * while keeping line breaks intact.
 */
export function inlineContextReferenceRemovalRanges(
  prompt: string,
  contextId: string,
): Array<{ readonly start: number; readonly end: number }> {
  const occurrences = collectComposerContextReferences(prompt).filter(
    (candidate) => candidate.contextId === contextId,
  );
  if (occurrences.length === 0) return [];
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  let rightBoundary = prompt.length;
  let reachedPromptEnd = true;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index]!;
    let { start, end } = occurrence;
    if (end < rightBoundary && prompt[end] === " ") {
      end += 1;
    } else if (start > 0 && prompt[start - 1] === " ") {
      start -= 1;
    }
    if (end < rightBoundary) {
      reachedPromptEnd = false;
    }
    if (reachedPromptEnd) {
      while (start > 0 && (prompt[start - 1] === " " || prompt[start - 1] === "\t")) {
        start -= 1;
      }
    }
    ranges.push({ start, end });
    rightBoundary = start;
  }
  return ranges.reverse();
}
