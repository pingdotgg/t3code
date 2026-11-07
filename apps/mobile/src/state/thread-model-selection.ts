import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope } from "./session";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { updateComposerDraftSettings } from "./use-composer-drafts";

/** Sets an existing thread's pick on the thread, so any next turn runs on it. */
export function selectThreadModel(
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  modelSelection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): void {
  const provider = providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  // A provider without the interaction-mode toggle runs in the default mode.
  updateComposerDraftSettings(scopedThreadKey(ref.environmentId, ref.threadId), {
    modelSelection,
    ...(provider?.showInteractionModeToggle === false
      ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
      : {}),
  });
  const thread = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  // Another instance replaces the live session, which may hold an open question; that pick
  // still waits for a sent message.
  if (
    thread?.modelSelection.instanceId !== modelSelection.instanceId ||
    !readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)
  ) {
    return;
  }
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setModelSelection,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId, modelSelection } },
    { label: "change model", reportFailure: true, reportDefect: true },
  );
}
