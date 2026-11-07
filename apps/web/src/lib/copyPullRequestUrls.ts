import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";

export async function copyPullRequestUrls(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    const didCopy = await writeTextToClipboard(urls.join("\n"), "pull request links");
    if (!didCopy) return;
    toastManager.add({
      type: "success",
      title: urls.length === 1 ? "PR link copied" : "PR links copied",
      description: urls.length === 1 ? urls[0] : `${urls.length} links`,
    });
  } catch (error) {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to copy PR links",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
