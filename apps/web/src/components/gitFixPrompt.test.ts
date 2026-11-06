import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { addGitFailureToComposer } from "./gitFixPrompt";

it("adds a delayed Git failure to the promoted composer while preserving its draft", () => {
  const environmentId = EnvironmentId.make("git-fix-promotion");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("git-fix-project"));
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("git-fix-thread"));
  const draftId = DraftId.make("git-fix-draft");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(projectRef, draftId, { threadId: threadRef.threadId });
  store.setPrompt(draftId, "Existing work");
  finalizePromotedDraftThreadByRef(threadRef);

  addGitFailureToComposer(draftId, new Error("The remote rejected the push."));

  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "Existing work\n\nHelp me fix this Git error:\n\nThe remote rejected the push.",
  );
});
