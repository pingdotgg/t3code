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
  const approvalDetail = approval.detail?.trim() ?? "";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approvalDetail.length > 0 ? (
        <div className="mt-2 rounded-xl border border-border/60 bg-background/80 px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
            Details
          </p>
          <pre
            className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/85"
            title={approvalDetail}
          >
            {approvalDetail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
