import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveThreadReferenceCopyTarget } from "@t3tools/shared/threadReference";
import { useCallback, useMemo } from "react";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "./ui/toast";
export function useThreadReferenceCopy(
  activeThreadRef: ScopedThreadRef | null,
  isServerThread: boolean,
  linkedPullRequestUrl: string | null,
) {
  const activeThreadId = activeThreadRef?.threadId ?? null;
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget = useMemo(
    () =>
      activeThreadId === null || !isServerThread
        ? null
        : resolveThreadReferenceCopyTarget({
            threadId: activeThreadId,
            openPanelPullRequestUrl,
            linkedPullRequestUrl: linkedPullRequestUrl,
          }),
    [activeThreadId, isServerThread, linkedPullRequestUrl, openPanelPullRequestUrl],
  );
  const copyActiveThreadReference = useCallback(() => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: target.failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, [activeThreadReferenceCopyTarget]);
  return copyActiveThreadReference;
}
