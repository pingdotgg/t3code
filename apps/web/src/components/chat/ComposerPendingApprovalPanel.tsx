import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const { t } = useI18n();
  const fallbackLabel =
    approval.requestKind === "command"
      ? t("chat.approval.command")
      : approval.requestKind === "file-read"
        ? t("chat.approval.fileRead")
        : t("chat.approval.fileChange");
  const detailAriaLabel =
    approval.requestKind === "command"
      ? t("chat.toolActivity.runCommand")
      : approval.requestKind === "file-read"
        ? t("chat.toolActivity.readFile")
        : t("chat.toolActivity.editFile");

  return (
    <div
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      role="group"
    >
      <code
        aria-label={detailAriaLabel}
        className="block max-h-20 min-w-0 flex-1 overflow-auto whitespace-pre font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.detail || fallbackLabel}
      </code>
      {pendingCount > 1 ? (
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
          1/{pendingCount}
        </span>
      ) : null}
    </div>
  );
});
