import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { FileDiffIcon, FileMinusIcon, FilePlusIcon, ShieldIcon } from "lucide-react";
import { memo, use, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "../../lib/utils";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";
import { useTurnItemDetail } from "../../state/queries";

function ApprovalFileDiff({ file }: { file: NonNullable<PendingApproval["files"]>[number] }) {
  const ctx = use(TimelineRowCtx);
  const detail = useTurnItemDetail(
    !file.diff && file.source
      ? { environmentId: ctx.activeThreadEnvironmentId, ...file.source }
      : null,
    ctx.turnItemSource?.detail,
  );
  const item = detail.data?.item;
  const diff = file.diff || (item?.type === "file_change" ? item.diffStr : undefined);
  return (
    <div>
      <div className="text-dim-foreground">{file.path}</div>
      {diff ? (
        <pre>
          <ApprovalDiffLines diff={diff} />
        </pre>
      ) : (
        <span className="text-muted-foreground">
          {detail.isPending
            ? "Loading diff…"
            : detail.error
              ? "Could not load diff."
              : "Diff is unavailable."}
        </span>
      )}
    </div>
  );
}

const APPROVAL_PRESENTATION = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    detailLabel: "App access request",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

function ApprovalDiffLines({ diff }: { diff: string }) {
  let offset = 0;
  return diff.match(/[^\n]*\n|[^\n]+$/g)?.map((line) => {
    const key = offset;
    offset += line.length;
    return (
      <span
        key={key}
        className={cn(
          line.startsWith("+") && !line.startsWith("+++")
            ? "text-success-foreground"
            : line.startsWith("-") && !line.startsWith("---")
              ? "text-error-foreground"
              : line.startsWith("@@")
                ? "text-info-foreground"
                : "text-muted-foreground",
        )}
      >
        {line}
      </span>
    );
  });
}

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const [allowSessionRequestId, setAllowSessionRequestId] = useState<
    PendingApproval["requestId"] | null
  >(null);
  const [diffRequestId, setDiffRequestId] = useState<PendingApproval["requestId"] | null>(null);
  const alwaysAllow = allowSessionRequestId === approval.requestId;
  const diffOpen = diffRequestId === approval.requestId;
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const files = approval.requestKind === "file-change" ? (approval.files ?? []) : [];
  const diffFiles = files.filter((file, index) =>
    file.source
      ? files.findIndex((other) => other.source?.itemId === file.source?.itemId) === index
      : Boolean(file.diff),
  );
  const hasDiff = canRespond && diffFiles.length > 0;
  return (
    <WorkLogRow
      role="group"
      aria-label={presentation.label}
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
          aria-label={presentation.detailLabel}
          className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-meta leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || presentation.label}
        </code>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-meta">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {files.length > 0 ? (
          <ul aria-label="Files to change" className="max-h-40 overflow-y-auto">
            {files.map((file) => (
              <li
                key={`${file.operation ?? ""}:${file.path}`}
                className="flex min-w-0 items-center gap-2"
              >
                {file.operation?.toLowerCase() === "add" ||
                file.operation?.toLowerCase() === "create" ||
                file.operation?.toLowerCase() === "added" ? (
                  <FilePlusIcon
                    aria-hidden
                    className="size-[13px] shrink-0 text-success-foreground"
                  />
                ) : file.operation?.toLowerCase() === "delete" ||
                  file.operation?.toLowerCase() === "remove" ||
                  file.operation?.toLowerCase() === "deleted" ? (
                  <FileMinusIcon
                    aria-hidden
                    className="size-[13px] shrink-0 text-error-foreground"
                  />
                ) : (
                  <FileDiffIcon aria-hidden className="size-[13px] shrink-0 text-info-foreground" />
                )}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                    {file.path}
                  </TooltipTrigger>
                  <TooltipPopup>{file.path}</TooltipPopup>
                </Tooltip>
                {file.additions !== undefined || file.deletions !== undefined ? (
                  <span className="shrink-0 font-mono text-caption tabular-nums">
                    <span className="text-success-foreground">+{file.additions ?? 0}</span>{" "}
                    <span className="text-error-foreground">−{file.deletions ?? 0}</span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {diffOpen ? (
          <div
            aria-label="Proposed diff"
            className="max-h-60 overflow-auto font-mono text-caption"
            tabIndex={0}
          >
            {diffFiles.map((file) => (
              <ApprovalFileDiff key={file.source?.itemId ?? file.path} file={file} />
            ))}
          </div>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning-foreground">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  {hasDiff ? (
                    <InlineButton
                      tone="muted"
                      aria-pressed={diffOpen}
                      onClick={() => setDiffRequestId(diffOpen ? null : approval.requestId)}
                    >
                      {diffOpen ? "Hide diff" : "Review diff"}
                    </InlineButton>
                  ) : null}
                  <ComposerPendingApprovalActions
                    alwaysAllow={alwaysAllow}
                    onAlwaysAllowChange={(checked) =>
                      setAllowSessionRequestId(checked ? approval.requestId : null)
                    }
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
            <span className="text-warning-foreground">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
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
