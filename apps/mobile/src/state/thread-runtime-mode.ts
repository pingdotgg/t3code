import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { beginRuntimeModePickSave } from "@t3tools/client-runtime/state/runtime-mode-picks";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import * as Dialog from "../components/ui/Dialog";
import { m } from "../i18n/messages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope } from "./session";
import { environmentThreadShells, threadEnvironment } from "./threads";
import {
  releaseComposerDraftRuntimeMode,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

/**
 * Sets an idle thread's runtime-mode pick on the thread, so turns that other threads, PR
 * watches, and schedules start there run in the mode the composer shows.
 */
export function selectThreadRuntimeMode(
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  runtimeMode: RuntimeMode,
): void {
  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  updateComposerDraftSettings(threadKey, { runtimeMode });
  const thread = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  // A mode change can end the provider session, so a busy thread takes the pick with its
  // next message instead.
  if (
    !thread ||
    threadRuntimeIsActive(thread.runtime) ||
    !readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)
  ) {
    return;
  }
  const settle = beginRuntimeModePickSave(threadKey, thread.runtimeMode, runtimeMode);
  if (settle === null) {
    // The thread already holds this mode, so the draft would only hide later changes.
    releaseComposerDraftRuntimeMode(threadKey, runtimeMode);
    return;
  }
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setRuntimeMode,
    {
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, runtimeMode, createdAt: new Date().toISOString() },
    },
    { label: "change permission mode", reportFailure: true, reportDefect: true },
  ).then((result) => {
    const releasable = settle(result._tag === "Success");
    // Released so a later change from another client shows, but only once the shell holds the
    // saved mode: until then a queued message would capture the old one and send it back.
    if (
      releasable !== null &&
      appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref))?.runtimeMode === releasable
    ) {
      releaseComposerDraftRuntimeMode(threadKey, releasable);
    }
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        m(msg("Could not apply permission mode")),
        m(
          msg("This mode applies to your next message. {detail}", {
            detail: errorDisplayMessage(error, m) ?? m(msg("Try again.")),
          }),
        ),
      );
    }
  });
}
