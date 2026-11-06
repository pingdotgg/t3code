import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { threadModelPickAppliesNow } from "@t3tools/shared/model";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope } from "./session";
import { environmentThreadShells, threadEnvironment } from "./threads";
import {
  releaseComposerDraftModelSelection,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

/** Sets an existing thread's pick on the thread, so any next turn runs on it. */
export function selectThreadModel(
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  value: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): void {
  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  // Its own object, so an older reply for an equal pick cannot release this one.
  const pick = { ...value };
  const provider = providers.find((candidate) => candidate.instanceId === pick.instanceId);
  // A provider without the interaction-mode toggle runs in the default mode.
  updateComposerDraftSettings(threadKey, {
    modelSelection: pick,
    ...(provider?.showInteractionModeToggle === false
      ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
      : {}),
  });
  const thread = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  if (!thread) return;
  if (
    !threadModelPickAppliesNow(pick, thread.modelSelection) ||
    !readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)
  ) {
    return;
  }
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setModelSelection,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId, modelSelection: pick } },
    { label: "change model", reportFailure: true, reportDefect: true },
  ).then((result) => {
    if (result._tag === "Success") releaseComposerDraftModelSelection(threadKey, pick);
  });
}
