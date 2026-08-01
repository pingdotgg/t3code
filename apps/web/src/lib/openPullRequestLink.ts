import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Opens a pull request in the user's real browser. Shared by both sidebars so
 * the desktop shell handoff (and its failure toasts) has a single definition.
 */
export function openPullRequestLink(
  // Structural rather than React.MouseEvent so keyboard activation shares it.
  event: { preventDefault: () => void; stopPropagation: () => void },
  prUrl: string,
): void {
  event.preventDefault();
  event.stopPropagation();

  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  void api.shell.openExternal(prUrl).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}
