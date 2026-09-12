import { useEffect } from "react";

export function useAcknowledgeThreadCompletion(
  threadKey: string | null,
  completedAt: string | null | undefined,
  acknowledge: (threadKey: string, completedAt: string) => void,
  deferWhilePageInactive: boolean,
) {
  useEffect(() => {
    if (threadKey === null || !completedAt) return;

    const acknowledgeIfViewed = () => {
      if (
        deferWhilePageInactive &&
        (document.visibilityState !== "visible" || !document.hasFocus())
      ) {
        return;
      }
      acknowledge(threadKey, completedAt);
    };

    acknowledgeIfViewed();
    window.addEventListener("focus", acknowledgeIfViewed);
    document.addEventListener("visibilitychange", acknowledgeIfViewed);
    return () => {
      window.removeEventListener("focus", acknowledgeIfViewed);
      document.removeEventListener("visibilitychange", acknowledgeIfViewed);
    };
  }, [acknowledge, completedAt, deferWhilePageInactive, threadKey]);
}
