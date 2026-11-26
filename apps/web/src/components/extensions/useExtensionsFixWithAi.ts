// Fork: Kaluwa's Extensions page. "Fix with AI": a new draft thread that opens on a prompt.
import type { EnvironmentId, ExtensionsSubscription } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { getDefaultProviderInstanceModel } from "../../providerInstances";
import { readEnvironmentProviders } from "../../state/environments";
import { toastManager } from "../ui/toast";
import { type ExtensionFixProblem, buildExtensionFixPrompt } from "./extensionsFixPrompt";

export function useExtensionsFixWithAi(environmentId: EnvironmentId) {
  const gt = useGT();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  return async (problem: ExtensionFixProblem, subscription: ExtensionsSubscription) => {
    const fix = buildExtensionFixPrompt(problem, subscription);
    const draft = defaultProjectRef
      ? await handleNewThread(defaultProjectRef, { prompt: fix.prompt })
      : null;
    if (draft === null) {
      toastManager.add({
        type: "error",
        title: gt("Add a project first"),
        description: gt(
          "Fix with AI starts a thread, and a thread needs a project. To fix it by hand: {steps}",
          { steps: fix.manual },
        ),
      });
      return;
    }
    // The agent of the subscription that has the problem is the one that can see its config.
    const providers = readEnvironmentProviders(environmentId) ?? [];
    const model = getDefaultProviderInstanceModel(providers, subscription.instanceId);
    if (model !== undefined && defaultProjectRef?.environmentId === environmentId) {
      useComposerDraftStore
        .getState()
        .setModelSelection(
          draft.draftId,
          { instanceId: subscription.instanceId, model },
          { replaceOptions: true },
        );
    }
  };
}
