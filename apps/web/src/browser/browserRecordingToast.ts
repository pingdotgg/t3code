import type { DesktopPreviewRecordingArtifact } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { revealInFileExplorerLabel } from "~/components/preview/fileExplorerLabel";
import { previewBridge } from "~/components/preview/previewBridge";

export function showBrowserRecordingSavedToast(artifact: DesktopPreviewRecordingArtifact) {
  const bridge = previewBridge;
  if (!bridge) return;
  let pathCopied = false;
  let toastId: ReturnType<typeof toastManager.add>;
  const revealAction = {
    children: revealInFileExplorerLabel(navigator.platform),
    onClick: () => void bridge.revealArtifact(artifact.path),
  };
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
  const savedToast = () =>
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
    });
  const updateRecordingToast = () => toastManager.update(toastId, savedToast());
  toastId = toastManager.add(savedToast());
}
