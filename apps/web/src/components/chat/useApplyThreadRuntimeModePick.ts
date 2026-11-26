import { msg } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RuntimeMode } from "@t3tools/contracts";
import { useContext } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Sets an idle thread's runtime-mode pick on the thread, so turns that other threads, PR
 * watches, and schedules start there run in the mode the composer shows.
 */
export function useApplyThreadRuntimeModePick() {
  const registry = useContext(RegistryContext);
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    label: "change permission mode",
  });
  return async (target: ComposerThreadTarget, runtimeMode: RuntimeMode) => {
    if (typeof target === "string") return;
    if (useComposerDraftStore.getState().draftThreadsByThreadKey[scopedThreadKey(target)]) return;
    const thread = registry.get(environmentThreadShells.threadShellAtom(target));
    // A mode change can end the provider session, so a busy thread takes the pick with its
    // next message instead.
    if (!thread || thread.runtimeMode === runtimeMode || threadRuntimeIsActive(thread.runtime)) {
      return;
    }
    const result = await setRuntimeMode({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, runtimeMode, createdAt: new Date().toISOString() },
    });
    if (result._tag === "Success") {
      // Released on the reply, so a later change from another client shows.
      const store = useComposerDraftStore.getState();
      if (store.getComposerDraft(target)?.runtimeMode === runtimeMode) {
        store.setRuntimeMode(target, null);
      }
    } else if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not apply permission mode")),
          description: m(
            msg("This mode applies to your next message. {detail}", {
              detail: thrownErrorMessage(error, m) ?? m(msg("Try again.")),
            }),
          ),
        }),
      );
    }
  };
}
