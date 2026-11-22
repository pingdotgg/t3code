import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { msg, T, useMessages } from "gt-react";
import { ShieldIcon } from "lucide-react";
import { memo, use } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";

const APPROVAL_PRESENTATION = {
  command: {
    icon: "terminal",
    label: msg("Command approval"),
    detailLabel: msg("Command", { $context: "noun, shell command awaiting approval" }),
  },
  "file-change": {
    icon: "square-pen",
    label: msg("File change approval"),
    detailLabel: msg("File change"),
  },
  "file-read": { icon: "eye", label: msg("File read approval"), detailLabel: msg("File to read") },
  permission: {
    icon: "wrench",
    label: msg("App permission approval"),
    detailLabel: msg("Permission request"),
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: msg("App access approval"),
    detailLabel: msg("App access request"),
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

const APPROVAL_EFFECT = {
  command: msg("Runs a command in the workspace"),
  "file-change": msg("Changes files in the workspace"),
  "file-read": msg("Reads a file in the workspace"),
  permission: msg("Changes what the agent may do"),
  "mcp-elicitation": msg("Gives an app access"),
} satisfies Record<PendingApproval["requestKind"], string>;

const SHOWS_WORKSPACE = new Set<PendingApproval["requestKind"]>([
  "command",
  "file-change",
  "file-read",
]);

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval, workspaceRoot } =
    use(TimelineRowCtx);
  const m = useMessages();
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  return (
    <div
      role="group"
      aria-label={m(presentation.label)}
      data-v2-item-type="approval_request"
      className="my-1.5 flex min-w-0 flex-col gap-2 rounded-lg border border-warning/40 bg-warning/4 p-3"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <ShieldIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span className="font-medium text-warning">
          <T>Approval required</T>
        </span>
        {approval.appName ? (
          <span className="min-w-0 truncate text-muted-foreground">{approval.appName}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-3.5 shrink-0 stroke-2 text-icon-muted"
          muted
        />
        <span className="shrink-0">{m(APPROVAL_EFFECT[approval.requestKind])}</span>
        {workspaceRoot && SHOWS_WORKSPACE.has(approval.requestKind) ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate font-mono">{workspaceRoot}</span>
          </>
        ) : null}
      </div>
      <code
        aria-label={m(presentation.detailLabel)}
        className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.detail || m(presentation.label)}
      </code>
      {approval.reason ? (
        <span className="text-xs text-muted-foreground select-text wrap-anywhere">
          {approval.reason}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canRespond ? (
          onRespondToApproval ? (
            <ComposerPendingApprovalActions
              presentation="card"
              requestId={approval.requestId}
              disabled={!canOperateThread}
              isResponding={respondingRequestIds.includes(approval.requestId)}
              canRespond={canRespond}
              options={approval.options}
              onRespondToApproval={onRespondToApproval}
            />
          ) : null
        ) : (
          <span className="text-xs text-warning">
            <T>Provider process is gone. Interrupt or restart the run to respond.</T>
          </span>
        )}
        {approval.fullAccessOverride ? (
          <Popover>
            <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
              {m(FULL_ACCESS_OVERRIDE_QUESTION)}
            </PopoverTrigger>
            <PopoverPopup
              aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
            </PopoverPopup>
          </Popover>
        ) : null}
      </div>
    </div>
  );
});
