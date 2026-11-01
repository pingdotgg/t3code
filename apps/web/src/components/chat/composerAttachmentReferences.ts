import {
  composerTargetKey,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  type ComposerContextReference,
  ensureInlineContextReferences,
} from "../../lib/composerContextReferences";

export function insertAttachmentReferencesForDraft(input: {
  target: ComposerThreadTarget;
  liveAttachmentTargetKey: string;
  references: ReadonlyArray<ComposerContextReference>;
  insertReferences: () => boolean;
}): boolean {
  if (composerTargetKey(input.target) !== input.liveAttachmentTargetKey) {
    // The shared editor now belongs to another draft or question.
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(input.target)?.prompt ?? "";
    store.setPrompt(input.target, ensureInlineContextReferences(prompt, input.references));
    return true;
  }
  return input.insertReferences();
}
