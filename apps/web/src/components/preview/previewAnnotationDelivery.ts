import {
  AuthOrchestrationOperateScope,
  PreviewAnnotationPayloadSchema,
  ScopedThreadRef,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { readThreadPreviewState } from "~/previewStateStore";
import { readEnvironmentScope } from "~/state/session";

const PoppedOutAnnotation = Schema.Struct({
  threadRef: ScopedThreadRef,
  tabId: Schema.String,
  runtimeTabId: Schema.String,
  picked: PreviewAnnotationPayloadSchema,
  screenshotFailed: Schema.Boolean,
});
type PoppedOutAnnotation = typeof PoppedOutAnnotation.Type;
const isPoppedOutAnnotation = Schema.is(PoppedOutAnnotation);

// The pop-out window has its own composer store, so its picks are handed to the chat window.
const CHANNEL_NAME = "t3code:preview-annotations";

export function addPreviewAnnotationToDraft(
  threadRef: ScopedThreadRef,
  picked: PreviewAnnotationPayload,
  screenshotFailed: boolean,
) {
  // Keep the annotation even if the crop fails; drop the screenshot so prompts cannot claim an attachment.
  const capture = capturePreviewAnnotationScreenshot(picked);
  const annotation = capture.status === "failed" ? { ...picked, screenshot: null } : picked;
  const store = useComposerDraftStore.getState();
  store.addPreviewAnnotation(threadRef, annotation);
  if (screenshotFailed || capture.status === "failed") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not capture the picked element",
        description: "The annotation was kept without the screenshot.",
      }),
    );
  }
  const file = capture.status === "captured" ? capture.file : null;
  const image =
    file && annotation.screenshot
      ? ({
          type: "image",
          id: annotation.id,
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: annotation.screenshot.dataUrl,
          file,
        } satisfies ComposerImageAttachment)
      : null;
  if (image) store.addImage(threadRef, image);
  return { annotation, image };
}

export function sendPreviewAnnotationToChatWindow(message: PoppedOutAnnotation) {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no target origin
  channel.postMessage(message);
  channel.close();
}

export function PoppedOutAnnotationReceiver() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to picks posted by pop-out preview windows
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isPoppedOutAnnotation(event.data)) return;
      const { threadRef, tabId, runtimeTabId, picked, screenshotFailed } = event.data;
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const state = readThreadPreviewState(threadRef);
      if (
        !state.desktopByTabId[tabId]?.detached ||
        runtimeTabId !== previewRuntimeTabId(threadRef, state.serverEpoch, tabId)
      )
        return;
      addPreviewAnnotationToDraft(threadRef, picked, screenshotFailed);
    };
    return () => channel.close();
  }, []);
  return null;
}
