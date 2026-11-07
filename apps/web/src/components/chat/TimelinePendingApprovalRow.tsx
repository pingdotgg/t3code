import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { memo, use } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRequestCard } from "./TimelineRequestCard";
import { TimelineRowCtx } from "./timelineRowContext";

const APPROVAL_PRESENTATION = {
  command: {
    icon: "terminal",
    label: "Command approval",
    title: "Run this command?",
    detailLabel: "Command",
  },
  "file-change": {
    icon: "square-pen",
    label: "File change approval",
    title: "Make this file change?",
    detailLabel: "File change",
  },
  "file-read": {
    icon: "eye",
    label: "File read approval",
    title: "Read this file?",
    detailLabel: "File to read",
  },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    title: "Allow this permission?",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    title: "Allow app access?",
    detailLabel: "App access request",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; title: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const showActions = canRespond && onRespondToApproval !== undefined;
  const showFooter = showActions || !canRespond || approval.fullAccessOverride !== undefined;
  return (
    <TimelineRequestCard
      role="group"
      aria-label={presentation.label}
      data-v2-item-type="approval_request"
      className="my-1.5"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            canRespond ? "bg-warning/12 text-warning" : "bg-muted text-icon-muted",
          )}
        >
          <ToolActivityIconView
            icon={undefined}
            fallbackName={presentation.icon}
            className="block size-3.5 shrink-0 stroke-2"
            muted={false}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-5 font-medium text-foreground">
            {presentation.title}
            {approval.appName ? <Badge variant="secondary">{approval.appName}</Badge> : null}
          </p>
          {approval.reason ? (
            <p className="text-xs leading-5 text-muted-foreground select-text wrap-anywhere">
              {approval.reason}
            </p>
          ) : null}
        </div>
      </div>
      <div className="min-w-0 rounded-lg border border-border/50 bg-muted/40">
        <ScrollArea
          scrollFade
          viewportTabIndex={0}
          viewportProps={{ role: "region", "aria-label": presentation.detailLabel }}
          className="max-h-40"
        >
          <code
            className="block px-3 py-2 whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere"
            data-approval-detail="complete"
          >
            {approval.detail || presentation.label}
          </code>
        </ScrollArea>
      </div>
      {showFooter ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {canRespond ? null : (
            <p className="w-full text-muted-foreground">
              Provider process is gone. Interrupt or restart the run to respond.
            </p>
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
          {showActions ? (
            <div className="ms-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1.5">
              <ComposerPendingApprovalActions
                requestId={approval.requestId}
                disabled={!canOperateThread}
                isResponding={respondingRequestIds.includes(approval.requestId)}
                canRespond={canRespond}
                options={approval.options}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </TimelineRequestCard>
  );
});
