import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { Dispatch, RefObject, SetStateAction } from "react";

import {
  isBrowserRecordingStartCancelledError,
  startBrowserRecording,
  stopBrowserRecording,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { readEnvironmentScope } from "~/state/session";

import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { previewBridge } from "./previewBridge";

type ComposerDraftStore = ReturnType<typeof useComposerDraftStore.getState>;

/** Screenshot/recording capture and element picking for the preview pane. */
export interface PreviewCaptureActionsInput {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string | null;
  readonly runtimeTabId: string | null;
  readonly recordingRuntimeTabId: string | null;
  readonly onSendAnnotation:
    | ((annotation: PreviewAnnotationPayload, image: ComposerImageAttachment | null) => void)
    | undefined;
  readonly pickActiveRef: RefObject<{ cancelled: boolean } | null>;
  readonly setPickActive: Dispatch<SetStateAction<boolean>>;
  readonly addPreviewAnnotation: ComposerDraftStore["addPreviewAnnotation"];
  readonly addImage: ComposerDraftStore["addImage"];
}

export interface PreviewCaptureActions {
  readonly handleCapture: (record: boolean) => void;
  readonly handlePickElement: () => void;
}

export function usePreviewCaptureActions(input: PreviewCaptureActionsInput): PreviewCaptureActions {
  const {
    threadRef,
    tabId,
    runtimeTabId,
    recordingRuntimeTabId,
    onSendAnnotation,
    pickActiveRef,
    setPickActive,
    addPreviewAnnotation,
    addImage,
  } = input;

const handleCapture = (record: boolean) => {
  if (!previewBridge || !runtimeTabId || !tabId) return;
  const bridge = previewBridge;
  if (recordingRuntimeTabId) {
    void stopBrowserRecording(recordingRuntimeTabId).then(
      (artifact) => {
        if (!artifact) return;
        let pathCopied = false;
        let toastId: ReturnType<typeof toastManager.add>;

        const copyPath = () => {
          if (!navigator.clipboard?.writeText) {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type: "error",
                title: "Unable to copy recording path",
                description: "Clipboard API unavailable.",
                actionProps: revealAction,
              }),
            );
            return;
          }

          void navigator.clipboard.writeText(artifact.path).then(
            () => {
              pathCopied = true;
              updateRecordingToast();
              window.setTimeout(() => {
                pathCopied = false;
                updateRecordingToast();
              }, 2_000);
            },
            (error) => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "error",
                  title: "Unable to copy recording path",
                  description: error instanceof Error ? error.message : "An error occurred.",
                  actionProps: revealAction,
                }),
              );
            },
          );
        };

        const revealAction = {
          children: revealInFileExplorerLabel(navigator.platform),
          onClick: () => void bridge.revealArtifact(artifact.path),
        };
        const updateRecordingToast = () => {
          toastManager.update(
            toastId,
            stackedThreadToast({
              type: "success",
              title: "Recording saved",
              actionProps: revealAction,
              data: {
                secondaryActionProps: {
                  children: pathCopied ? "Copied!" : "Copy path",
                  disabled: pathCopied,
                  onClick: copyPath,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        };

        toastId = toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Recording saved",
            actionProps: revealAction,
            data: {
              secondaryActionProps: {
                children: "Copy path",
                onClick: copyPath,
              },
              secondaryActionVariant: "outline",
            },
          }),
        );
      },
      (error) => {
        toastManager.add({
          type: "error",
          title: "Unable to stop recording",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
    return;
  }
  if (record) {
    void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
      const description = error instanceof Error ? error.message : "An error occurred.";
      if (isBrowserRecordingStartCancelledError(error)) return;
      toastManager.add({
        type: "error",
        title: "Unable to start recording",
        description,
      });
    });
    return;
  }
  void bridge.captureScreenshot(runtimeTabId).then(
    (artifact) => {
      const revealAction = {
        children: revealInFileExplorerLabel(navigator.platform),
        onClick: () => void bridge.revealArtifact(artifact.path),
      };
      let pathCopied = false;
      let imageCopied = false;
      let toastId: ReturnType<typeof toastManager.add>;

      const updateScreenshotToast = (
        type: "success" | "error" = "success",
        title = "Screenshot saved",
        description?: string,
      ) => {
        toastManager.update(
          toastId,
          stackedThreadToast({
            type,
            title,
            description,
            actionProps: {
              children: imageCopied ? "Copied!" : "Copy image",
              disabled: imageCopied,
              onClick: copyImage,
            },
            data: {
              additionalActions: [
                {
                  id: "copy-path",
                  props: {
                    children: pathCopied ? "Copied!" : "Copy path",
                    disabled: pathCopied,
                    onClick: copyPath,
                  },
                },
              ],
              secondaryActionProps: {
                ...revealAction,
              },
              secondaryActionVariant: "outline",
            },
          }),
        );
      };

      const copyPath = () => {
        if (!navigator.clipboard?.writeText) {
          updateScreenshotToast(
            "error",
            "Unable to copy screenshot path",
            "Clipboard API unavailable.",
          );
          return;
        }

        void navigator.clipboard.writeText(artifact.path).then(
          () => {
            pathCopied = true;
            updateScreenshotToast();
            window.setTimeout(() => {
              pathCopied = false;
              updateScreenshotToast();
            }, 2_000);
          },
          (error) => {
            updateScreenshotToast(
              "error",
              "Unable to copy screenshot path",
              error instanceof Error ? error.message : "An error occurred.",
            );
          },
        );
      };

      const copyImage = () => {
        void bridge.copyArtifactToClipboard(artifact.path).then(
          () => {
            imageCopied = true;
            updateScreenshotToast();
            window.setTimeout(() => {
              imageCopied = false;
              updateScreenshotToast();
            }, 2_000);
          },
          (error) => {
            updateScreenshotToast(
              "error",
              "Unable to copy screenshot",
              error instanceof Error ? error.message : "An error occurred.",
            );
          },
        );
      };

      toastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Screenshot saved",
          actionProps: {
            children: "Copy image",
            onClick: copyImage,
          },
          data: {
            additionalActions: [
              {
                id: "copy-path",
                props: {
                  children: "Copy path",
                  onClick: copyPath,
                },
              },
            ],
            secondaryActionProps: {
              ...revealAction,
            },
            secondaryActionVariant: "outline",
          },
        }),
      );
    },
    (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to capture screenshot",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  );
};

const handlePickElement = () => {
  if (!previewBridge || !runtimeTabId) return;
  if (pickActiveRef.current) {
    pickActiveRef.current.cancelled = true;
    void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
    return;
  }
  // Capture app focus before main moves it into guest webContents.
  const previouslyFocused =
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  const pickRequest = { cancelled: false };
  let submitted = false;
  pickActiveRef.current = pickRequest;
  setPickActive(true);
  const finishPick = () => {
    const isCurrentPick = pickActiveRef.current === pickRequest;
    if (isCurrentPick) {
      pickActiveRef.current = null;
      setPickActive(false);
    }
    if (
      (isCurrentPick || submitted) &&
      previouslyFocused &&
      previouslyFocused.isConnected &&
      typeof previouslyFocused.focus === "function"
    ) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {}
    }
  };
  const bridge = previewBridge;
  void settlePromise(async () => {
    await bridge.setAnnotationSendEnabled(
      runtimeTabId,
      Boolean(onSendAnnotation) &&
        readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
    );
    if (pickRequest.cancelled) return;
    const result = await bridge.pickElement(runtimeTabId);
    if (!result || pickRequest.cancelled) return;
    // The accepted pick must survive further clicks, tab changes, and unmount; stop cancellation here.
    if (pickActiveRef.current === pickRequest) {
      pickActiveRef.current = null;
      setPickActive(false);
      submitted = true;
    }
    const { annotation: picked, submission, screenshotFailed = false } = result;
    // Send annotations even if the optional crop fails or stalls; drop failed screenshots so prompts cannot
    // claim an attachment.
    const capture = capturePreviewAnnotationScreenshot(picked);
    const cropDropped = screenshotFailed || capture.status === "failed";
    const annotation = capture.status === "failed" ? { ...picked, screenshot: null } : picked;
    addPreviewAnnotation(threadRef, annotation);
    if (cropDropped) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not capture the picked element",
          description: "The annotation was kept without the screenshot.",
        }),
      );
    }
    const screenshotFile = capture.status === "captured" ? capture.file : null;
    const image =
      screenshotFile && annotation.screenshot
        ? ({
            type: "image",
            id: annotation.id,
            name: screenshotFile.name,
            mimeType: screenshotFile.type,
            sizeBytes: screenshotFile.size,
            previewUrl: annotation.screenshot.dataUrl,
            file: screenshotFile,
          } satisfies ComposerImageAttachment)
        : null;
    if (image) {
      addImage(threadRef, image);
    }
    if (
      submission === "send" &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      onSendAnnotation?.(annotation, image);
    }
  }).then(finishPick);
};


  return { handleCapture, handlePickElement };
}
