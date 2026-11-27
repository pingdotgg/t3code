import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_LABEL,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  CheckIcon,
  FileDiffIcon,
  FileMinusIcon,
  FilePlusIcon,
  MinusIcon,
  ShieldIcon,
} from "lucide-react";
import {
  memo,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { formatWorkspaceRelativeDetail, formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useLayoutPaneFocusedRef } from "../../layout/layoutPaneContext";
import { cn } from "../../lib/utils";
import { type PendingApproval } from "../../session-logic";
import { useTurnItemDetail } from "../../state/queries";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ApprovalText } from "./ApprovalText";
import { BackgroundThreadContext } from "./backgroundThread";
import {
  ComposerPendingApprovalActions,
  DEFAULT_APPROVAL_OPTIONS,
  resolveApprovalPrimaryDecision,
} from "./ComposerPendingApprovalActions";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";
import { TimelineApprovalCtx, TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow, WorkLogTarget, WorkLogVerb } from "./WorkLog";

function keepsApprovalKeys(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, button, a[href], [role="button"], [role="link"], summary, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]',
    ) !== null
  );
}

function subscribeApprovalFocus(listener: () => void) {
  const onFocusOut = () => queueMicrotask(listener);
  document.addEventListener("focusin", listener);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    document.removeEventListener("focusin", listener);
    document.removeEventListener("focusout", onFocusOut);
  };
}

const approvalKeysAvailable = () => !keepsApprovalKeys(document.activeElement);

function ApprovalFileDiff({ file }: { file: NonNullable<PendingApproval["files"]>[number] }) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const detail = useTurnItemDetail(
    !file.diff && file.source && ctx
      ? { environmentId: ctx.activeThreadEnvironmentId, ...file.source }
      : null,
    ctx?.turnItemSource?.detail,
  );
  const item = detail.data?.item;
  const diff = file.diff || (item?.type === "file_change" ? item.diffStr : undefined);
  return (
    <div>
      <div className="text-dim-foreground">
        {formatWorkspaceRelativePath(file.path, ctx?.workspaceRoot)}
      </div>
      {diff ? (
        <pre>
          <ApprovalDiffLines diff={diff} />
        </pre>
      ) : (
        <span className="text-muted-foreground">
          {detail.isPending
            ? gt("Loading diff…")
            : detail.error
              ? gt("Could not load diff.")
              : gt("Diff is unavailable.")}
        </span>
      )}
    </div>
  );
}

const APPROVAL_PRESENTATION = {
  command: {
    label: msg("Command approval"),
    detailLabel: msg("Command", { $context: "noun, shell command awaiting approval" }),
  },
  "file-change": {
    label: msg("File change approval"),
    detailLabel: msg("File change"),
  },
  "file-read": { label: msg("File read approval"), detailLabel: msg("File to read") },
  permission: {
    label: msg("App permission approval"),
    detailLabel: msg("Permission request"),
  },
  "mcp-elicitation": {
    label: msg("App access approval"),
    detailLabel: msg("App access request"),
  },
} satisfies Record<PendingApproval["requestKind"], { label: string; detailLabel: string }>;

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

export function TimelineApprovalCard({
  approval,
  title,
  ariaLabel,
  headerTrailing,
  workspaceRoot,
  disabled,
  isResponding,
  enableShortcuts = false,
  unavailableMessage,
  error,
  onRespond,
  onAnswered,
}: {
  approval: PendingApproval;
  title?: string | undefined;
  ariaLabel?: string | undefined;
  headerTrailing?: ReactNode;
  workspaceRoot?: string | undefined;
  disabled: boolean;
  isResponding: boolean;
  enableShortcuts?: boolean;
  unavailableMessage?: ReactNode;
  error?: string | null | undefined;
  onRespond?:
    | ((requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<unknown>)
    | undefined;
  onAnswered?: (() => void) | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const backgroundThread = use(BackgroundThreadContext);
  const paneFocusedRef = useLayoutPaneFocusedRef();
  const cardRef = useRef<HTMLDivElement>(null);
  const showShortcutHints = useSyncExternalStore(subscribeApprovalFocus, approvalKeysAvailable);
  const [diffRequestId, setDiffRequestId] = useState<PendingApproval["requestId"] | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const diffOpen = diffRequestId === approval.requestId;
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const detail =
    approval.requestKind === "file-change"
      ? formatWorkspaceRelativeDetail(approval.detail, workspaceRoot)
      : approval.detail;
  const canRespond = approval.responseCapability === "live";
  const canUseShortcuts =
    enableShortcuts && !disabled && !isResponding && canRespond && !backgroundThread && !!onRespond;
  const options = approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const primary = resolveApprovalPrimaryDecision(options, alwaysAllow);
  const decline = options.find((option) => option.decision === "decline");
  const files = approval.requestKind === "file-change" ? (approval.files ?? []) : [];
  const diffFiles = files.filter((file, index) =>
    file.source
      ? files.findIndex((other) => other.source?.itemId === file.source?.itemId) === index
      : Boolean(file.diff),
  );
  const hasDiff = canRespond && diffFiles.length > 0;

  const submitDecision = async (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    viaShortcut = false,
  ) => {
    if (!onRespond) return;
    const focusInsideCard =
      viaShortcut || (cardRef.current?.contains(document.activeElement) ?? false);
    const result = await onRespond(requestId, decision);
    if (focusInsideCard && onAnswered) onAnswered();
    return result;
  };

  const respondFromShortcut = useEffectEvent((key: string) => {
    const decision = key === "Enter" ? primary?.decision : decline?.decision;
    if (decision) void submitDecision(approval.requestId, decision, true);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- active timeline approval shortcuts work in the focused pane while editors, buttons, menus and dialogs keep their own keys
  useEffect(() => {
    if (!canUseShortcuts) return;
    const handler = (event: KeyboardEvent) => {
      if (!paneFocusedRef.current) return;
      if (
        (event.key !== "Escape" && event.key !== "Enter") ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (keepsApprovalKeys(event.target)) return;
      if (!(event.key === "Enter" ? primary : decline)) return;
      event.preventDefault();
      respondFromShortcut(event.key);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [canUseShortcuts, primary, decline, paneFocusedRef]);

  const { pushHooks } = approval;
  const label = pushHooks ? PUSH_HOOKS_APPROVAL_LABEL : presentation.label;
  const cardTitle = title ?? m(label);
  const cardAriaLabel = ariaLabel ?? m(label);

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={cardAriaLabel}
      data-v2-item-type="approval_request"
      data-approval-request-id={approval.requestId}
      className="@container/approval-card my-1.5 flex min-w-0 flex-col gap-2.5 rounded-card surface-panel p-3 text-meta"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <ShieldIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 text-label text-foreground wrap-anywhere">{cardTitle}</span>
            {approval.appName ? (
              <span className="min-w-0 truncate text-meta text-muted-foreground">
                {approval.appName}
              </span>
            ) : null}
          </div>
        </div>
        {approval.fullAccessOverride || headerTrailing ? (
          <div className="ms-auto flex shrink-0 items-center gap-2">
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
            {headerTrailing}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col rounded-control surface-well">
        {pushHooks ? (
          <div className="flex min-w-0 flex-col gap-2 p-2.5">
            <span className="block min-w-0 text-meta text-foreground select-text! wrap-anywhere">
              {m(PUSH_HOOKS_APPROVAL_QUESTION)}
            </span>
            <PushHooksApprovalDetails pushHooks={pushHooks} />
          </div>
        ) : files.length > 0 ? (
          <>
            {detail ? (
              <div
                aria-label={m(presentation.detailLabel)}
                className="px-2.5 pt-2 text-meta text-muted-foreground select-text! wrap-anywhere"
                data-approval-detail="complete"
              >
                {detail}
              </div>
            ) : null}
            <ul
              aria-label={gt("Files to change")}
              className="flex max-h-40 flex-col gap-1 overflow-y-auto px-2.5 py-2"
            >
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
                    <FileDiffIcon
                      aria-hidden
                      className="size-[13px] shrink-0 text-info-foreground"
                    />
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="min-w-0 flex-1 truncate text-foreground" />}
                    >
                      {formatWorkspaceRelativePath(file.path, workspaceRoot)}
                    </TooltipTrigger>
                    <TooltipPopup>{file.path}</TooltipPopup>
                  </Tooltip>
                  {file.additions !== undefined || file.deletions !== undefined ? (
                    <span className="shrink-0 text-meta tabular-nums">
                      <span className="text-success-foreground">+{file.additions ?? 0}</span>{" "}
                      <span className="text-error-foreground">−{file.deletions ?? 0}</span>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {diffOpen ? (
              <div
                aria-label={gt("Proposed diff")}
                className="max-h-60 overflow-auto border-t border-divider p-2.5 font-mono text-caption"
                tabIndex={0}
              >
                {diffFiles.map((file) => (
                  <ApprovalFileDiff key={file.source?.itemId ?? file.path} file={file} />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5 p-2.5">
            <ApprovalText
              text={detail || m(presentation.label)}
              label={m(presentation.detailLabel)}
              className={
                approval.requestKind === "command"
                  ? "text-meta"
                  : "font-sans text-meta text-muted-foreground"
              }
            />
          </div>
        )}
      </div>

      {approval.reason ? (
        <p className="text-meta text-muted-foreground select-text wrap-anywhere">
          {approval.reason}
        </p>
      ) : null}

      {!canRespond ? (
        <p className="text-meta text-warning-foreground">
          {unavailableMessage ?? (
            <T>Provider process is gone. Interrupt or restart the run to respond.</T>
          )}
        </p>
      ) : null}

      {onRespond ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          {hasDiff ? (
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={diffOpen}
              onClick={() => setDiffRequestId(diffOpen ? null : approval.requestId)}
            >
              <FileDiffIcon aria-hidden />
              {diffOpen ? gt("Hide diff") : gt("Review diff")}
            </Button>
          ) : null}
          <ComposerPendingApprovalActions
            designLabels
            showShortcutHints={showShortcutHints && canUseShortcuts}
            requestId={approval.requestId}
            disabled={disabled}
            isResponding={isResponding}
            canRespond={canRespond}
            options={approval.options}
            alwaysAllow={alwaysAllow}
            onAlwaysAllowChange={setAlwaysAllow}
            onRespondToApproval={(requestId, decision) =>
              submitDecision(requestId, decision, false)
            }
          />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-meta text-error-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const rowCtx = use(TimelineRowCtx);
  const approvalCtx = use(TimelineApprovalCtx);
  return (
    <TimelineApprovalCard
      approval={approval}
      workspaceRoot={rowCtx?.workspaceRoot}
      disabled={!approvalCtx.canOperateThread}
      isResponding={approvalCtx.respondingRequestIds.includes(approval.requestId)}
      enableShortcuts={approval.requestId === approvalCtx.activeShortcutRequestId}
      onRespond={approvalCtx.onRespondToApproval}
      onAnswered={approvalCtx.onApprovalAnswered}
    />
  );
});

export function TimelineAnsweredApprovalRow({
  item,
}: {
  item: Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;
}) {
  const rowCtx = use(TimelineRowCtx);
  const approvalCtx = use(TimelineApprovalCtx);
  const gt = useGT();
  const decision = approvalCtx.resolvedApprovalDecisions.get(item.requestId);
  const approved =
    decision === "accept" ||
    decision === "acceptForSession" ||
    decision === "acceptAlways" ||
    (decision === undefined && item.status === "completed");
  const verb =
    decision === "acceptForSession"
      ? gt("Approved for session")
      : decision === "acceptAlways"
        ? gt("Always approved")
        : decision === "decline"
          ? gt("Declined")
          : decision === "cancel"
            ? gt("Cancelled")
            : approved
              ? gt("Approved")
              : gt("Declined");
  const rawDetail =
    item.requestKind === "file-change"
      ? formatWorkspaceRelativeDetail(item.prompt, rowCtx?.workspaceRoot)
      : item.prompt;
  const target = rawDetail?.trim().replace(/\s+/gu, " ") || item.appName || null;
  const Icon = approved ? CheckIcon : MinusIcon;
  return (
    <WorkLogRow
      data-v2-item-type="approval_request"
      icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
      label={
        <span className="flex min-w-0 items-baseline gap-1.5">
          <WorkLogVerb>{verb}</WorkLogVerb>
          {target ? <WorkLogTarget>{target}</WorkLogTarget> : null}
        </span>
      }
    />
  );
}
