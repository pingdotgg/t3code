import { toastManager } from "~/components/ui/toast";
import type { PreviewStreamDownload } from "@t3tools/client-runtime/preview/server-browser-stream";

/** Browsers may refuse a write that arrives after the key press; a toast button is a fresh gesture. */
export async function copyPageText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const id = toastManager.add({
      type: "info",
      title: "The page copied text",
      actionProps: {
        children: "Copy",
        onClick: () => {
          toastManager.close(id);
          void navigator.clipboard.writeText(text).catch(() => undefined);
        },
      },
    });
  }
}

export function offerDownload(download: PreviewStreamDownload): void {
  const id = toastManager.add({
    type: "info",
    title: `Downloaded ${download.fileName}`,
    actionProps: {
      children: "Save",
      onClick: () => {
        toastManager.close(id);
        const anchor = document.createElement("a");
        anchor.href = download.url;
        anchor.download = download.fileName;
        anchor.click();
      },
    },
  });
}
