import {
  composerTargetKey,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  type ComposerContextReference,
  ensureInlineContextReferences,
} from "../../lib/composerContextReferences";

/** Route references that finish preparing asynchronously to the draft that accepted them. */
export function insertAttachmentReferencesForDraft(input: {
  target: ComposerThreadTarget;
  liveAttachmentTargetKey: string;
  references: ReadonlyArray<ComposerContextReference>;
  insertReferences: () => boolean;
}): boolean {
  if (composerTargetKey(input.target) !== input.liveAttachmentTargetKey) {
    // The shared editor and prompt ref now belong to another draft or question.
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(input.target)?.prompt ?? "";
    store.setPrompt(input.target, ensureInlineContextReferences(prompt, input.references));
    return true;
  }
  return input.insertReferences();
}
