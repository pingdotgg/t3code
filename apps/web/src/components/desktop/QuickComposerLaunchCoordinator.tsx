import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { DesktopQuickComposerLaunch } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useQuickComposerAutoSendStore } from "../../quickComposer";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Starts each Quick Composer prompt as a new thread through the normal composer send. */
export function QuickComposerLaunchCoordinator() {
  const handleNewThread = useNewThreadHandler();
  const quickComposer = window.desktopBridge?.quickComposer;

  const launch = useEffectEvent(async (request: DesktopQuickComposerLaunch) => {
    const opened = await handleNewThread(
      scopeProjectRef(request.environmentId, request.projectId),
      { prompt: request.prompt },
    ).catch(() => null);
    if (opened === null) {
      toastManager.add(stackedThreadToast({ type: "error", title: "Could not start the thread" }));
      return;
    }
    // A draft the user already typed in keeps its text, and must not be sent in its place.
    if (
      useComposerDraftStore.getState().getComposerDraft(opened.draftId)?.prompt !== request.prompt
    ) {
      void navigator.clipboard.writeText(request.prompt).catch(() => undefined);
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "This project already has a draft",
          description: "Your prompt was copied to the clipboard instead of sent.",
        }),
      );
      return;
    }
    useQuickComposerAutoSendStore.getState().request(opened.draftId);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Quick Composer launches over the desktop bridge
  useEffect(() => quickComposer?.onLaunch((request) => void launch(request)), [quickComposer]);

  return null;
}
