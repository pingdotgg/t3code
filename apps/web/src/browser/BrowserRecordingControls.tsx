import { PreviewCaptureButton } from "~/components/preview/PreviewCaptureButton";
import { toastManager } from "~/components/ui/toast";
import { stopBrowserRecording, useBridgeBrowserRecordingTabIds } from "./browserRecording";
import { showBrowserRecordingSavedToast } from "./browserRecordingToast";

export function BrowserRecordingControls() {
  const tabIds = useBridgeBrowserRecordingTabIds();
  if (!tabIds.size) return null;
  return (
    <div className="fixed top-[var(--workspace-controls-top)] right-[calc(var(--workspace-controls-right)+var(--workspace-titlebar-controls-width,6rem))] z-[100] flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]">
      {[...tabIds].map((tabId) => (
        <PreviewCaptureButton
          key={tabId}
          recording
          onCapture={() => {
            void stopBrowserRecording(tabId).then(
              (artifact) => {
                if (artifact) showBrowserRecordingSavedToast(artifact);
              },
              (error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to stop recording",
                  description: error instanceof Error ? error.message : "An error occurred.",
                });
              },
            );
          }}
        />
      ))}
    </div>
  );
}
