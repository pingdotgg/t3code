import { memo, use, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronDownIcon, MinusIcon, XIcon } from "lucide-react";
import {
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { getRenderablePatch, resolveFileDiffPath } from "../../lib/diffRendering";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { buildInlineFileChangePatch, InlineFileDiff } from "./WorkEntryInlineDiffs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import {
  TimelineRowCtx,
  TimelineRowActivityCtx,
  type TimelineWorkEntry,
  WorkEntryIconSvg,
  workToneIcon,
  workEntryIconName,
  workEntryPreview,
  toolWorkEntryHeading,
  buildToolCallExpandedBody,
  toolCallExpandedBodyClassName,
  stopRowToggle,
} from "./MessagesTimeline";

export const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const activity = use(TimelineRowActivityCtx);
  const timelineRow = use(TimelineRowCtx);
  const clientWordWrap = useClientSettings((settings) => settings.wordWrap);
  const [wordWrap, setWordWrap] = useState(clientWordWrap);
  const [expanded, setExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const inlineFileChanges =
    workEntry.fileChanges ?? (workEntry.fileChange ? [workEntry.fileChange] : []);
  const inlineFilePatches = inlineFileChanges.flatMap((change) => {
    const patch = buildInlineFileChangePatch(change);
    const renderablePatch = patch
      ? getRenderablePatch(patch, `work-log:${workEntry.id}:${change.filePath}`, {
          upgradeFullContextFiles: true,
        })
      : null;
    return renderablePatch?.kind === "files"
      ? renderablePatch.files.map((fileDiff) => ({ change, fileDiff }))
      : [];
  });
  const expandedBody =
    inlineFilePatches.length > 0 ? null : buildToolCallExpandedBody(workEntry, workspaceRoot);
  const canExpand = expandedBody !== null || inlineFilePatches.length > 0;
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-icon-muted"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-secondary-label">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-icon-muted">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
          onKeyDown={stopRowToggle}
        >
          {inlineFilePatches.map(({ change, fileDiff }) => (
            <InlineFileDiff
              key={`${workEntry.id}:${resolveFileDiffPath(fileDiff)}`}
              change={change}
              fileDiff={fileDiff}
              environmentId={timelineRow.activeThreadEnvironmentId}
              workspaceRoot={workspaceRoot}
              theme={timelineRow.resolvedTheme}
              wordWrap={wordWrap}
              onToggleWordWrap={() => setWordWrap((w) => !w)}
            />
          ))}
          {expandedBody ? (
            <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
