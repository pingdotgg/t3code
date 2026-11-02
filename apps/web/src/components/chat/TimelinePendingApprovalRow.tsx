import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useT } from "../../hooks/useI18n";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { ShieldIcon } from "lucide-react";
import { memo, use } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: {
    icon: "terminal",
    label: "chat.approvalRow.command",
    detailLabel: "chat.approvalRow.commandDetail",
  },
  "file-change": {
    icon: "square-pen",
    label: "chat.approvalRow.fileChange",
    detailLabel: "chat.approvalRow.fileChangeDetail",
  },
  "file-read": {
    icon: "eye",
    label: "chat.approvalRow.fileRead",
    detailLabel: "chat.approvalRow.fileReadDetail",
  },
  permission: {
    icon: "wrench",
    label: "chat.approvalRow.permission",
    detailLabel: "chat.approvalRow.permissionDetail",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "chat.approvalRow.appAccess",
    detailLabel: "chat.approvalRow.appAccessDetail",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: MessageKey; detailLabel: MessageKey }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const t = useT();
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  return (
    <WorkLogRow
      role="group"
      aria-label={t(presentation.label)}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <code
          aria-label={t(presentation.detailLabel)}
          className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || t(presentation.label)}
        </code>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                {t("chat.approvalRow.waiting")}
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={onRespondToApproval}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">{t("chat.approvalRow.processGone")}</span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
});
