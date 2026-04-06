import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";
  const detailLabel =
    approval.requestKind === "command"
      ? "Command"
      : approval.requestKind === "file-read"
        ? "Requested path"
        : "Requested changes";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-3 rounded-xl border border-border/70 bg-background/80 px-3 py-2.5 shadow-xs/5">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
            {detailLabel}
          </p>
          <pre
            data-testid="pending-approval-detail"
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all select-text font-mono text-[12px] leading-relaxed text-foreground"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
