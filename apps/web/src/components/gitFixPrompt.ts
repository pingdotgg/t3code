import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

export function addGitFailureToComposer(target: ComposerThreadTarget, error: unknown): void {
  const store = useComposerDraftStore.getState();
  const resolvedTarget =
    typeof target === "string" ? (store.getPromotedDraftRedirect(target) ?? target) : target;
  const existing = store.getComposerDraft(resolvedTarget)?.prompt ?? "";
  const message = error instanceof Error ? error.message : "An error occurred.";
  const prompt = `Help me fix this Git error:\n\n${message}`;
  store.setPrompt(resolvedTarget, existing ? `${existing}\n\n${prompt}` : prompt);
}
