import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { useEffect } from "react";
import { useGT } from "gt-react";
import { toastManager } from "../ui/toast";
import { useStableCallback } from "../../hooks/useStableCallback";

export function useVaultApprovalToast(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: TurnItemId,
  pending = true,
  onReview?: () => void,
) {
  const gt = useGT();
  const review = useStableCallback(() => onReview?.());
  const hasReview = onReview !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the imperative approval toast tied to the pending request, closing it when the request resolves or leaves this view.
  useEffect(() => {
    if (!pending) return;
    const id = toastManager.add({
      id: `vault-${environmentId}-${requestId}`,
      type: "info",
      title: gt("Vault access needs your attention"),
      description: gt(
        "Review the vault request in this conversation. Never enter your PIN in chat.",
      ),
      timeout: 0,
      ...(hasReview ? { actionProps: { children: gt("Review request"), onClick: review } } : {}),
      data: { hideCopyButton: true, threadRef: { environmentId, threadId } },
    });
    return () => toastManager.close(id);
  }, [pending, environmentId, threadId, requestId, gt, hasReview, review]);
}
