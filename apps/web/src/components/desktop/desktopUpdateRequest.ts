import { stackedThreadToast, toastManager } from "../ui/toast";

export async function requestCoordinatedDesktopUpdate(): Promise<void> {
  try {
    const command = window.desktopBridge?.updateCommand;
    if (!command) throw new Error("Update T3 Code to use its coordinated updater.");
    const response = await command.request();
    if (!response.ok) throw new Error(response.message);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update T3 Code",
        description:
          error instanceof Error ? error.message : "The coordinated updater is unavailable.",
      }),
    );
  }
}
