import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadModelPickAppliesNow } from "@t3tools/shared/model";
import { useContext } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/** Sets an existing thread's composer pick on the thread, so any next turn runs on it. */
export function useApplyThreadModelPick() {
  const registry = useContext(RegistryContext);
  const setModelSelection = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    label: "change model",
  });
  return async (target: ComposerThreadTarget) => {
    if (typeof target === "string") return;
    const store = useComposerDraftStore.getState();
    const draft = store.draftsByThreadKey[scopedThreadKey(target)];
    if (!draft?.modelSelectionExplicit || !draft.activeProvider) return;
    const pick = draft.modelSelectionByProvider[draft.activeProvider];
    const thread = registry.get(environmentThreadShells.threadShellAtom(target));
    if (!pick || !thread || store.draftThreadsByThreadKey[scopedThreadKey(target)]) return;
    if (!threadModelPickAppliesNow(pick, thread.modelSelection)) return;
    const result = await setModelSelection({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, modelSelection: pick },
    });
    if (result._tag === "Success") {
      useComposerDraftStore.getState().releaseModelSelection(target, pick);
    }
  };
}
