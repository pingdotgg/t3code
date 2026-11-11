import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useContext } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

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
    // Another instance replaces the live session, which may hold an open question; that pick
    // still waits for a sent message.
    if (pick.instanceId !== thread.modelSelection.instanceId) return;
    const result = await setModelSelection({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, modelSelection: pick },
    });
    if (result._tag === "Success") {
      useComposerDraftStore.getState().releaseModelSelection(target, pick);
    } else if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not apply model selection",
          description: `This model pick was not saved. ${error instanceof Error ? error.message : "Try again."}`,
        }),
      );
    }
  };
}
