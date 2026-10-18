import type { ModelSelection } from "@t3tools/contracts";
import type { ComposerDraft } from "./use-composer-drafts";
import { modelSelectionsEqual } from "./thread-outbox-model";

/** A local choice overrides only the thread model it was made against. */
export function resolveThreadComposerModelSelection(
  draft: ComposerDraft | null | undefined,
  threadModelSelection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!draft?.modelSelection) return threadModelSelection ?? null;
  if (!threadModelSelection) return draft.modelSelection;
  if (draft.modelSelectionBase) {
    return modelSelectionsEqual(draft.modelSelectionBase, threadModelSelection)
      ? draft.modelSelection
      : threadModelSelection;
  }
  // Older builds retained the last sent model in an empty draft indefinitely.
  // Keep legacy unsent content and recovered messages' explicit choices.
  return draft.text.length > 0 || draft.attachments.length > 0
    ? draft.modelSelection
    : threadModelSelection;
}
