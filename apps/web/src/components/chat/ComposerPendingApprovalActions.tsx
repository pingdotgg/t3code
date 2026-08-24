import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";
import { useI18n } from "~/i18n";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-normal";

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const { t } = useI18n();

  return (
    <>
      <Button
        size="micro"
        variant="ghost-muted"
        className={APPROVAL_ACTION_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        {t("chat.approval.cancelTurn")}
      </Button>
      <Button
        size="micro"
        variant="ghost-muted"
        className={`${APPROVAL_ACTION_CLASS_NAME} text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground`}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        {t("chat.approval.decline")}
      </Button>
      <Button
        size="micro"
        variant="ghost-muted"
        className={APPROVAL_ACTION_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        {t("chat.approval.allowSession")}
      </Button>
      <Button
        size="micro"
        variant="ghost-muted"
        className={`${APPROVAL_ACTION_CLASS_NAME} text-foreground`}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        {t("chat.approval.approveOnce")}
      </Button>
    </>
  );
});
