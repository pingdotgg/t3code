import { THINKING_PREVIEW_PLUGINS, THOUGHT_PREVIEW_PLUGINS } from "./TimelineWorkEntryRow.logic";
import {
  type TimelinePendingRequest,
  type TimelineRow,
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineWorkEntry,
  WorkGroupViewCtx,
} from "./timelineRowContext";
import { V2SubagentGroup } from "./TimelineV2EventRow";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import {
  ActivityShimmerOverlay,
  MESSAGE_HEADING_LEVEL,
  SlashCommandChip,
  WORKING_BAR_CLASS_NAME,
  WorkingBarControl,
  useCarriedTextFade,
} from "./TimelineRowParts";
import {
  ToolActivityIconView,
  type WorkEntryIconName,
  failedToolIconClassName,
  toolIconAcceptsTint,
} from "./TimelineToolActivityIcon";
import { toolGroupSummaryIconName, workEntryIconName } from "./TimelineWorkEntryRow.logic";
import {
  ReasoningTraceContent,
  SimpleWorkEntryRow,
  ThreadReadLabel,
  threadReadLabel,
  useThreadReadTarget,
} from "./TimelineWorkEntryRow";
import { formatWorkingTimer, formatWorkingTimerNow } from "./TimelineWorkGroupRows.logic";
import { WorkLogButton, WorkLogList, WorkLogRow, WorkLogTarget, WorkLogVerb } from "./WorkLog";
import {
  type WorktreeSetupSnapshot,
  type ToolActivityIcon,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { liveThoughtLine } from "@t3tools/client-runtime/work-log/presentation";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import { observeResize } from "~/lib/observeResize";
import { tickTextContent } from "~/lib/tickTextContent";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  memo,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { workEntryDisplayIndicatesToolFailure } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import {
  Minimize2Icon,
  XIcon,
  BellIcon,
  ActivityIcon,
  TerminalIcon,
  UsersIcon,
  CircleXIcon,
  MessageCircleQuestionMarkIcon,
  RefreshCwIcon,
  ShieldQuestionMarkIcon,
  ArrowDownIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { getVirtualizedScrollFadeClassName, ScrollArea } from "../ui/scroll-area";
import {
  liveWorkEntryLabel,
  resolveWorkGroupScrollIndex,
  shouldFollowWorkGroupAppend,
  workEntryIsVisibleInGroup,
  type MessagesTimelineRow,
  type TimelineSlashCommand,
  type WorkingWindow,
  type WorkingWindowItem,
} from "./MessagesTimeline.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  SkillChipPopover,
  skillInstructionsOpener,
  skillPopoverDescription,
} from "./SkillInlineText";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { useAssistantMessageText } from "../../state/entities";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { presentSlashCommand } from "./timelineSlashCommands";
import { commandRunsTests } from "@t3tools/shared/toolOutput";
import { DiffStatBlocks } from "./DiffStatLabel";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

export const WorkGroupSection = memo(function WorkGroupSection({
  anchorKey,
  disclosureAnchorKey = anchorKey,
  groupedEntries,
  isExpandedToolGroup,
  displayLabel,
}: {
  anchorKey: string;
  disclosureAnchorKey?: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroup: boolean;
  displayLabel?: string | undefined;
}) {
  const { workspaceRoot, routeThreadKey, onToggleWorkEntry, pendingApprovals } =
    use(TimelineRowCtx);
  const onToggleStandaloneEntry = () => onToggleWorkEntry(disclosureAnchorKey);
  const nonEmptyEntries = groupedEntries.filter((entry) => {
    const item = entry.projectedItem?.item;
    return (
      (item?.type === "approval_request" && pendingApprovals.has(item.requestId)) ||
      workEntryIsVisibleInGroup(entry, isExpandedToolGroup)
    );
  });

  if (nonEmptyEntries.length === 0) return null;
  if (isExpandedToolGroup && nonEmptyEntries.every((entry) => entry.itemType === "reasoning")) {
    return <ReasoningTraceContent entries={nonEmptyEntries} />;
  }
  if (isExpandedToolGroup) {
    return (
      <ExpandedWorkGroupEntries
        key={`${routeThreadKey}:${anchorKey}`}
        anchorKey={anchorKey}
        disclosureAnchorKey={disclosureAnchorKey}
        entries={nonEmptyEntries}
        workspaceRoot={workspaceRoot}
      />
    );
  }

  return (
    <section aria-label="Activity">
      {nonEmptyEntries.map((workEntry) => (
        <SimpleWorkEntryRow
          key={workEntry.id}
          workEntry={workEntry}
          workspaceRoot={workspaceRoot}
          displayLabel={displayLabel}
          onToggleEntry={onToggleStandaloneEntry}
        />
      ))}
    </section>
  );
});

function WorkingTimer({ createdAt, clock = false }: { createdAt: string; clock?: boolean }) {
  return (
    <span
      ref={tickTextContent(() => formatWorkingTimerNow(createdAt, clock), true)}
      className="tabular-nums"
    />
  );
}

const compactWorkEntryHeight = 24;

function ExpandedWorkGroupEntries({
  anchorKey,
  disclosureAnchorKey,
  entries,
  workspaceRoot,
}: {
  anchorKey: string;
  disclosureAnchorKey: string;
  entries: TimelineWorkEntry[];
  workspaceRoot: string | undefined;
}) {
  const { workGroupViewState: viewState, onToggleWorkEntry } = use(TimelineRowCtx);
  const [initialScrollIndex] = useState(() =>
    resolveWorkGroupScrollIndex(entries, viewState.scrollPositions.get(anchorKey)),
  );
  const [restoringPosition, setRestoringPosition] = useState(initialScrollIndex !== undefined);
  const listRef = useRef<LegendListRef>(null);
  const [expandedContentHeight, setExpandedContentHeight] = useState(0);
  const [fades, setFades] = useState({ top: false, bottom: false, viewportHeight: 0 });
  const [appendState, setAppendState] = useState({ entries, follow: false });
  // Capture the pre-change edge once per incoming array, before new layout
  // metrics arrive. Edge/viewport changes never turn a status update into a follow.
  if (appendState.entries !== entries) {
    setAppendState({
      entries,
      follow:
        fades.viewportHeight > 0 &&
        shouldFollowWorkGroupAppend(appendState.entries, entries, fades.bottom ? Infinity : 0),
    });
  }

  const groupView = {
    state: viewState,
    onToggleEntry: () => onToggleWorkEntry(disclosureAnchorKey),
  };
  const updateScrollFades = () => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    const viewportHeight = element.clientHeight;
    const top = element.scrollTop > 1;
    const bottom = distanceFromEnd > 1;
    setFades((previous) =>
      previous.top === top &&
      previous.bottom === bottom &&
      previous.viewportHeight === viewportHeight
        ? previous
        : { top, bottom, viewportHeight },
    );
  };

  const handleScroll = () => {
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (position) {
      viewState.scrollPositions.set(anchorKey, {
        entryId: position.rowId,
        offset: position.offsetWithinRow,
      });
    }
    updateScrollFades();
  };

  const handleLoad = () => {
    const list = listRef.current;
    const element = list?.getScrollableNode();
    if (initialScrollIndex && list && element) {
      // Bootstrap can report the restored target before the DOM has applied it.
      // Reconcile once at load, before releasing the measured anchor row.
      const offset = Math.max(
        0,
        Math.min(list.getState().scroll, element.scrollHeight - element.clientHeight),
      );
      if (Math.abs(element.scrollTop - offset) > 1) {
        void list.scrollToOffset({ offset, animated: false });
      }
    }
    setRestoringPosition(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the list scroller and its content with ResizeObserver to update scroll fades
  useLayoutEffect(() => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    updateScrollFades();
    const content = element.firstElementChild;
    return observeResize(content ? [element, content] : element, updateScrollFades);
  }, [updateScrollFades]);

  const renderEntry = ({ item }: { item: TimelineWorkEntry }) => (
    <SimpleWorkEntryRow key={item.id} workEntry={item} workspaceRoot={workspaceRoot} />
  );

  const updateExpandedContentHeight = () => {
    const state = listRef.current?.getState();
    let height = 0;
    for (const entryId of viewState.expandedEntries) {
      if (state?.indexByKey(entryId) === undefined) continue;
      height += Math.max(
        0,
        (state.sizes.get(entryId) ?? compactWorkEntryHeight) - compactWorkEntryHeight,
      );
    }
    setExpandedContentHeight(height);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads expanded row sizes from LegendList's measured state after layout
  useLayoutEffect(updateExpandedContentHeight, [entries, updateExpandedContentHeight]);

  return (
    <WorkGroupViewCtx value={groupView}>
      <WorkLogList>
        <LegendList
          ref={listRef}
          data={entries}
          extraData={workspaceRoot}
          keyExtractor={workEntryKey}
          renderItem={renderEntry}
          estimatedItemSize={compactWorkEntryHeight}
          drawDistance={240}
          recycleItems
          {...(initialScrollIndex ? { initialScrollIndex } : {})}
          maintainScrollAtEnd={
            appendState.follow ? { animated: false, on: { dataChange: true } } : false
          }
          maintainScrollAtEndThreshold={1 / Math.max(1, fades.viewportHeight)}
          // Measure the restored row even when an intra-row offset puts its
          // estimated bounds outside the list's small bootstrap render window.
          {...(restoringPosition && initialScrollIndex
            ? { alwaysRender: { indices: [initialScrollIndex.index] } }
            : {})}
          maintainVisibleContentPosition
          onLoad={handleLoad}
          onScroll={handleScroll}
          onLayout={updateScrollFades}
          onItemSizeChanged={updateExpandedContentHeight}
          tabIndex={0}
          role="region"
          aria-label="Tool calls"
          data-tool-group-scroll
          style={{ maxHeight: `calc(min(18rem, 50dvh) + ${expandedContentHeight}px)` }}
          className={cn(
            "scrollbar-gutter-stable scroll-py-6 -me-(--chat-lane-reach) overflow-x-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            getVirtualizedScrollFadeClassName(fades),
          )}
        />
      </WorkLogList>
    </WorkGroupViewCtx>
  );
}

const workEntryKey = (entry: TimelineWorkEntry) => entry.id;

export function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const ctx = use(TimelineRowCtx);
  const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup, pendingRequest } =
    use(TimelineRowActivityCtx);
  const window = row.window;
  if (
    window?.compactCommand &&
    window.items.length === 0 &&
    !window.stopping &&
    !pendingRequest &&
    !isPreparingWorktree &&
    !backgroundWorktreeSetup
  )
    return null;
  const compacting =
    row.compacting !== undefined || isCompacting || workingWindowHasActiveCompaction(window);
  const label = isPreparingWorktree ? (
    "Setting up worktree…"
  ) : window?.stopping ? (
    "Stopping…"
  ) : pendingRequest && row.createdAt ? (
    // The clock stops while the turn waits on the user.
    `Paused at ${formatWorkingTimer(row.createdAt, pendingRequest.createdAt) ?? "0s"}`
  ) : compacting ? (
    <span className="inline-flex items-center gap-2">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      {row.createdAt ? (
        <>
          Compacting for <WorkingTimer createdAt={row.createdAt} />
        </>
      ) : (
        "Compacting…"
      )}
    </span>
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} />
    </>
  ) : (
    "Working..."
  );
  const historyOpen = window?.historyOpen ?? false;
  const foldable = window !== undefined && (historyOpen || window.items.length > 0);
  return (
    <div>
      <div className={WORKING_BAR_CLASS_NAME}>
        <WorkingBarControl
          variant="history"
          aria-expanded={foldable ? historyOpen : undefined}
          aria-label={
            foldable ? (historyOpen ? "Close work history" : "Open work history") : undefined
          }
          disabled={!foldable}
          data-scroll-anchor-ignore
          onClick={foldable ? () => ctx.onToggleWorkingHistory(window.key) : undefined}
        >
          <span
            ref={isPreparingWorktree ? observeVisibleAnimation : undefined}
            className="relative shrink-0 overflow-hidden whitespace-nowrap"
          >
            {label}
            {isPreparingWorktree ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
          </span>
          {foldable ? (
            <MorphIcon
              aria-hidden
              className="size-3 shrink-0 text-dim-foreground"
              icon={historyOpen ? ChevronDown : ChevronRight}
            />
          ) : null}
        </WorkingBarControl>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
        <div className="ms-auto flex min-w-0 items-center justify-end">
          {window ? <WorkingBarSlot window={window} pendingRequest={pendingRequest} /> : null}
        </div>
      </div>
      {window ? <WorkingWindowView window={window} itemKey={row.id} /> : null}
    </div>
  );
}

function BackgroundWorktreeSetupChip({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const ctx = use(TimelineRowCtx);
  const terminalId = snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            className="ml-auto min-w-0 shrink-0"
            aria-label={`Background setup is still running: ${scriptName}. Show setup progress.`}
          />
        }
      >
        <Spinner className="size-3 shrink-0" />
        <span className="truncate">Background setup</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <WorktreeSetupCard
          snapshot={snapshot}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function ThinkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "thinking" }> }) {
  const ctx = use(TimelineRowCtx);
  const { isCompacting, isPreparingWorktree, liveAnswerPreview } = use(TimelineRowActivityCtx);
  if (isPreparingWorktree || isCompacting) return <WorkLogRow label="" />;
  // A failed group keeps this disclosure while an approval waits, but nothing is thinking then.
  const live = ctx.pendingApprovals.size === 0;
  const { groupId } = row;
  const activity = (
    <LiveActivityRow label={liveAnswerPreview ?? "Thinking"} iconName="brain" active={live} />
  );
  if (groupId === undefined) return activity;
  return (
    <LiveWorkToggle
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId, row.id)}
    >
      {activity}
    </LiveWorkToggle>
  );
}

/** A live activity row that is its work group's disclosure: the whole row toggles it. */
function LiveWorkToggle({
  stacked = false,
  ...props
}: Omit<ComponentProps<"button">, "type" | "className"> & {
  /** Stacks a thought line above the status row. */
  stacked?: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 items-end gap-2.5">
      <button
        type="button"
        className={cn(
          "group/live-work flex min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          stacked ? "flex-col items-start" : "min-h-6 items-center",
        )}
        {...props}
      />
    </div>
  );
}

function LiveActivityRow({
  label,
  iconName,
  toolIcon,
  failed = false,
  active = false,
}: {
  label: ReactNode;
  iconName?: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  active?: boolean;
}) {
  const { isWorking, pendingRequest, turnEnded } = use(TimelineRowActivityCtx);
  const animated = isWorking && active && !failed && !pendingRequest && !turnEnded;
  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-full min-w-0 overflow-hidden rounded-md"
    >
      <LiveActivityContent
        label={label}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        announceFailure={failed}
      />
      {animated ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent label={label} iconName={iconName} toolIcon={toolIcon} highlighted />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  toolIcon,
  failed = false,
  announceFailure = false,
  highlighted = false,
}: {
  label: ReactNode;
  iconName: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(toolIcon);

  return (
    <WorkLogRow
      icon={
        iconName ? (
          <span
            className={cn(
              "flex size-3.5 items-center justify-center",
              failed
                ? failedToolIconClassName
                : highlighted
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
            role={announceFailure ? "img" : undefined}
            aria-label={announceFailure ? "Tool call failed" : undefined}
          >
            <ToolActivityIconView
              icon={toolIcon}
              fallbackName={iconName}
              className="block size-3.5 shrink-0 stroke-2"
              muted={!highlighted}
            />
          </span>
        ) : null
      }
      label={
        <span className={cn("block truncate", highlighted && "text-foreground")}>{label}</span>
      }
      trailing={
        showTrailingFailureMark ? (
          <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
        ) : null
      }
    />
  );
}

export function LiveWorkEntryTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-live" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const threadTarget = useThreadReadTarget(row.entry, ctx.activeThreadEnvironmentId);
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const threadLabel = threadReadLabel(label, threadTarget);

  const item = row.entry.projectedItem?.item;
  const pendingApproval =
    item?.type === "approval_request" ? ctx.pendingApprovals.get(item.requestId) : undefined;
  if (pendingApproval) return <TimelinePendingApprovalRow approval={pendingApproval} />;

  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  const thoughtLine = row.thought && !row.expanded ? liveThoughtLine(row.thought.detail ?? "") : "";
  const thoughtIsStatus = thoughtLine !== "" && row.entry === row.thought;

  return (
    <LiveWorkToggle
      stacked={thoughtLine !== ""}
      aria-label={
        failed
          ? `${thoughtLine ? `${thoughtLine} ` : ""}${threadLabel?.text ?? label}, tool call failed`
          : undefined
      }
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      {thoughtLine ? (
        <WorkLogRow
          icon={
            <span className="flex size-4 items-center justify-center text-icon-muted">
              <ToolActivityIconView
                icon={undefined}
                fallbackName="brain"
                className="block size-4 shrink-0 stroke-2"
                muted
              />
            </span>
          }
          label={
            <span className="line-clamp-4">
              <ChatMarkdown
                inline
                text={thoughtLine}
                cwd={ctx.markdownCwd}
                parseRawHtml={false}
                extraRemarkPlugins={THOUGHT_PREVIEW_PLUGINS}
              />
            </span>
          }
          wrapLabel
        />
      ) : null}
      <LiveActivityRow
        label={
          thoughtIsStatus ? (
            row.active ? (
              "Thinking"
            ) : (
              "Thought"
            )
          ) : row.entry.itemType === "reasoning" ? (
            <ChatMarkdown
              inline
              text={row.entry.detail ?? label}
              cwd={ctx.markdownCwd}
              parseRawHtml={false}
              extraRemarkPlugins={row.active ? THINKING_PREVIEW_PLUGINS : THOUGHT_PREVIEW_PLUGINS}
            />
          ) : threadLabel ? (
            <ThreadReadLabel
              label={threadLabel}
              environmentId={ctx.activeThreadEnvironmentId}
              linked={false}
            />
          ) : (
            label
          )
        }
        iconName={workEntryIconName(row.entry)}
        toolIcon={row.entry.toolIcon ?? row.entry.toolSource?.icon}
        failed={failed}
        active={row.active}
      />
    </LiveWorkToggle>
  );
}

export function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkGroupHeader
      label={row.summary}
      iconName={row.toolSurface ?? toolGroupSummaryIconName(row.summaryKind)}
      toolIcon={row.toolIcon}
      failed={row.hasFailure}
      expanded={row.expanded}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    />
  );
}

function WorkGroupHeader(props: {
  label: string;
  iconName: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <WorkLogButton
      aria-label={props.failed ? `${props.label}, tool call failed` : props.label}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      icon={
        <ToolActivityIconView
          icon={props.toolIcon}
          fallbackName={props.iconName}
          className="size-3.5 shrink-0 stroke-2 text-muted-foreground"
          muted
        />
      }
      label={<span className="block truncate text-secondary-label">{props.label}</span>}
    />
  );
}

export function BackgroundActivityTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "background-activity" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const label = `${row.updateCount} ${row.updateCount === 1 ? "wake-up" : "wake-ups"}${row.active ? "…" : ""}`;
  const summary = row.updates.map((update) => update.summary).join(", ");
  const sources = new Map<string, number>();
  for (const update of row.updates) {
    sources.set(update.source.kind, (sources.get(update.source.kind) ?? 0) + 1);
  }
  return (
    <WorkLogButton
      aria-label={`${label}: ${summary}`}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.id, row.id)}
      icon={<BellIcon aria-hidden className="size-3.5 text-muted-foreground" />}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-label">{label}</span>
          <span className="min-w-0 flex-1 truncate text-body text-dim-foreground">{summary}</span>
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-0.75">
            {[...sources].map(([kind, count]) => {
              const Icon =
                kind === "monitor"
                  ? ActivityIcon
                  : kind === "command"
                    ? TerminalIcon
                    : kind === "subagent" || kind === "delegated_task"
                      ? UsersIcon
                      : BellIcon;
              return (
                <span
                  key={kind}
                  aria-label={`${count} ${kind.replaceAll("_", " ")}`}
                  className="inline-flex shrink-0 items-center gap-1 text-dim-foreground"
                >
                  <Icon aria-hidden className="size-3" />
                </span>
              );
            })}
          </span>
          <span aria-hidden className="size-3 shrink-0" />
        </span>
      }
    />
  );
}

/** A request waiting on the user, in the tone of its slot: approvals warn, questions inform. */
function WorkingRequestRow({ entry }: { entry: TimelineWorkEntry }) {
  const ctx = use(TimelineRowCtx);
  const approval = entry.itemType === "approval_request";
  const target = approval ? (entry.command ?? entry.detail ?? null) : "for your answer";
  return (
    <WorkLogRow
      icon={
        approval ? (
          <ShieldQuestionMarkIcon aria-hidden className="size-3.5 text-warning-foreground" />
        ) : (
          <MessageCircleQuestionMarkIcon aria-hidden className="size-3.5 text-info-foreground" />
        )
      }
      label={
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={cn(
              "shrink-0 text-label",
              approval ? "text-warning-foreground" : "text-info-foreground",
            )}
          >
            {approval ? (entry.command ? "Wants to run" : "Needs approval") : "Waiting"}
          </span>
          {target ? (
            <span className="min-w-0 truncate text-dim-foreground">
              {approval && entry.command
                ? formatWorkspaceRelativePath(entry.command, ctx.workspaceRoot)
                : target}
            </span>
          ) : null}
        </span>
      }
    />
  );
}

function WorkingWindowText({
  item,
  itemKey,
}: {
  item: Extract<WorkingWindowItem, { kind: "text" }>;
  itemKey: string;
}) {
  const ctx = use(TimelineRowCtx);
  const liveText = useAssistantMessageText(
    item.message.streaming ? ctx.threadRef : null,
    item.projectedItemId,
  );
  const text = liveText ?? item.message.text;
  const textRef = useCarriedTextFade(item.message.id);
  if (text.trim().length === 0) return null;
  return (
    <div ref={textRef} className="min-w-0 py-2">
      <AssistantCitationSource
        messageId={item.message.id}
        {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
        itemKey={itemKey}
        request={ctx.citationRequest}
        listRef={ctx.listRef}
      >
        <ChatMarkdown
          text={text}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={Boolean(item.message.streaming)}
          lineBreaks={shouldPreserveAssistantLineBreaks(text)}
          skills={ctx.skills}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onUseArtifactTemplate={ctx.onUseArtifactTemplate}
          onRunShellCommand={ctx.onRunShellCommand}
          onImageExpand={ctx.onImageExpand}
        />
      </AssistantCitationSource>
    </div>
  );
}

const WorkingWindowItemView = memo(function WorkingWindowItemView({
  item,
  itemKey,
  current,
}: {
  item: WorkingWindowItem;
  itemKey: string;
  current: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  if (item.kind === "text") {
    return <WorkingWindowText item={item} itemKey={itemKey} />;
  }
  if (item.kind === "agents") {
    return <V2SubagentGroup row={item.row} />;
  }
  const { entry } = item;
  if (entry.toolLifecycleStatus === "inProgress") {
    if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
      return <WorkingRequestRow entry={entry} />;
    }
    return (
      <LiveActivityRow
        label={liveWorkEntryLabel(entry, ctx.workspaceRoot, true)}
        iconName={workEntryIconName(entry)}
        toolIcon={entry.toolIcon ?? entry.toolSource?.icon}
        active={current}
      />
    );
  }
  const failedTestRun =
    entry.itemType === "command_execution" &&
    workEntryDisplayIndicatesToolFailure(entry) &&
    commandRunsTests(entry.command ?? entry.label);
  return (
    <SimpleWorkEntryRow
      workEntry={entry}
      workspaceRoot={ctx.workspaceRoot}
      severeFailure={failedTestRun}
    />
  );
});

function WorkingWindowView({ window, itemKey }: { window: WorkingWindow; itemKey: string }) {
  const ctx = use(TimelineRowCtx);
  const { isCompacting, isPreparingWorktree, turnEnded, pendingRequest, liveAnswerPreview } =
    use(TimelineRowActivityCtx);
  const open = window.historyOpen;
  const [history, setHistory] = useState<{ head: number; tailStart: number } | null>(null);
  if (open && history === null) {
    setHistory({
      head: WORKING_HISTORY_BATCH,
      tailStart: Math.max(0, window.items.length - WORKING_WINDOW_TAIL),
    });
  }
  const windowRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [collapseClips, setCollapseClips] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the expanded height before the collapse transition paints its first frame
  useLayoutEffect(() => {
    if (open) return;
    setCollapseClips((windowRef.current?.scrollHeight ?? 0) > WORKING_WINDOW_COLLAPSED_HEIGHT);
  }, [open]);
  const { onWorkingHistoryCollapsing } = ctx;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- older items stay mounted, and the timeline stops following its end, until the collapse transition finishes
  useEffect(() => {
    if (open || history === null) return;
    onWorkingHistoryCollapsing(true);
    let cancelled = false;
    void transitionsSettled(windowRef.current).then(() => {
      if (!cancelled) setHistory(null);
    });
    return () => {
      cancelled = true;
      onWorkingHistoryCollapsing(false);
    };
  }, [open, history, onWorkingHistoryCollapsing]);
  const head = history?.head;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts older items as the timeline scroll brings them near the viewport
  useEffect(() => {
    const spacer = spacerRef.current;
    if (!open || head === undefined || !spacer) return;
    let observer: IntersectionObserver | undefined;
    let cancelled = false;
    void transitionsSettled(windowRef.current).then(() => {
      if (cancelled) return;
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setHistory(
            (current) => current && { ...current, head: current.head + WORKING_HISTORY_BATCH },
          );
        },
        { scrollMargin: "100% 0px" },
      );
      observer.observe(spacer);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [open, head]);
  const { workGroupViewState, onToggleWorkEntry } = ctx;
  // Entries opened in the history keep their state, and toggling one keeps the bar in place.
  const groupView = (() => ({
    state: workGroupViewState,
    onToggleEntry: () => onToggleWorkEntry("working-indicator-row"),
  }))();
  const headEnd = history ? Math.min(history.head, history.tailStart) : 0;
  const unmounted = history ? history.tailStart - headEnd : 0;
  const shown = history
    ? window.items.slice(history.tailStart)
    : window.items.slice(-WORKING_WINDOW_TAIL);
  const renderItem = (item: WorkingWindowItem) => (
    <div key={item.id} className="min-w-0">
      <WorkingWindowItemView item={item} itemKey={itemKey} current={item === window.items.at(-1)} />
    </div>
  );
  const showThinking =
    !turnEnded &&
    !pendingRequest &&
    !window.answering &&
    !workingWindowItemIsLive(window.items.at(-1)) &&
    !isCompacting &&
    !isPreparingWorktree &&
    !workingWindowHasActiveCompaction(window);
  if (shown.length === 0 && !showThinking) return null;
  return (
    <WorkGroupViewCtx value={groupView}>
      <div
        ref={windowRef}
        role="region"
        aria-label="Work history"
        className={cn(
          // The gap under the bar sits inside the window, so its fade reaches the hairline.
          "flex min-w-0 flex-col justify-end gap-1 overflow-clip pt-2 transition-[height] duration-200 ease-out motion-reduce:transition-none",
          open
            ? "[height:calc-size(auto,size)]"
            : "[height:calc-size(auto,min(size,220px))] not-supports-[height:calc-size(auto,size)]:max-h-[220px]",
          !open && history !== null && collapseClips && "working-window-collapse-fade",
        )}
      >
        {history === null ? (
          <CollapsedWorkingWindow
            key={window.key}
            items={window.items}
            itemKey={itemKey}
            showThinking={showThinking}
          />
        ) : (
          <>
            {history ? window.items.slice(0, headEnd).map(renderItem) : null}
            {unmounted > 0 ? (
              <div
                ref={spacerRef}
                aria-hidden
                className="shrink-0"
                style={{ height: unmounted * (compactWorkEntryHeight + 4) }}
              />
            ) : null}
            {shown.map(renderItem)}
            {showThinking ? (
              <LiveActivityRow label={liveAnswerPreview ?? "Thinking"} iconName="brain" active />
            ) : null}
          </>
        )}
      </div>
    </WorkGroupViewCtx>
  );
}

function CollapsedWorkingWindow({
  items,
  itemKey,
  showThinking,
}: {
  items: WorkingWindow["items"];
  itemKey: string;
  showThinking: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const prependRef = useRef<{ height: number; top: number; inSpacer: boolean } | null>(null);
  const [following, setFollowing] = useState(true);
  const [start, setStart] = useState(() => Math.max(0, items.length - WORKING_WINDOW_TAIL));
  const getViewport = () =>
    rootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  // Following runs in ResizeObserver after layout; only a prepend needs correction before paint.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preserves the visible offset when mounting an older batch
  useLayoutEffect(() => {
    const prepend = prependRef.current;
    if (!prepend) return;
    const viewport = getViewport();
    if (!viewport) return;
    viewport.scrollTop =
      prepend.top + (prepend.inSpacer ? 0 : viewport.scrollHeight - prepend.height);
    prependRef.current = null;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- content can grow between renders while markdown and command output stream
  useLayoutEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const content = contentRef.current;
    if (!viewport || !content) return;
    viewport.scrollTop = viewport.scrollHeight;
    return observeResize([content, viewport], () => {
      if (followRef.current) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts older items as scrolling brings the spacer near the viewport
  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const spacer = spacerRef.current;
    if (start === 0 || !viewport || !spacer) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (prependRef.current || !entries.some((entry) => entry.isIntersecting)) return;
        prependRef.current = {
          height: viewport.scrollHeight,
          top: viewport.scrollTop,
          inSpacer:
            viewport.scrollTop === 0 ||
            viewport.scrollTop + viewport.clientHeight <= spacer.offsetHeight,
        };
        setStart((current) => Math.max(0, current - WORKING_HISTORY_BATCH));
      },
      { root: viewport, rootMargin: "80px 0px" },
    );
    observer.observe(spacer);
    return () => observer.disconnect();
  }, [start]);

  return (
    <div className="relative min-h-0 min-w-0 shrink-0">
      <ScrollArea
        ref={rootRef}
        className="h-auto max-h-[212px]"
        scrollFade
        scrollFadePadding={false}
        chainVerticalScroll
        viewportTabIndex={0}
        onScrollCapture={(event) => {
          const viewport = getViewport();
          if (!viewport || event.target !== viewport || prependRef.current) return;
          const atEnd = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
          followRef.current = atEnd;
          setFollowing(atEnd);
          if (atEnd) setStart(Math.max(start, items.length - WORKING_WINDOW_TAIL));
        }}
      >
        <div ref={contentRef} className="flex min-w-0 flex-col gap-1">
          {start > 0 ? (
            <div
              ref={spacerRef}
              aria-hidden
              className="shrink-0"
              style={{ height: start * (compactWorkEntryHeight + 4) }}
            />
          ) : null}
          {items.slice(start).map((item) => (
            <div key={item.id} className="min-w-0">
              <WorkingWindowItemView
                item={item}
                itemKey={itemKey}
                current={item === items.at(-1)}
              />
            </div>
          ))}
          {showThinking ? <LiveActivityRow label="Thinking" iconName="brain" active /> : null}
        </div>
      </ScrollArea>
      {!following ? (
        <div className="pointer-events-none absolute end-2 bottom-1">
          <div className="pointer-events-auto">
            <Button
              size="compact"
              variant="secondary"
              onClick={() => {
                followRef.current = true;
                setFollowing(true);
                const viewport = getViewport();
                if (viewport) viewport.scrollTop = viewport.scrollHeight;
              }}
            >
              <ArrowDownIcon aria-hidden />
              Jump to latest
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function workingWindowItemIsLive(item: WorkingWindowItem | undefined): boolean {
  if (item === undefined) return false;
  if (item.kind === "work") return item.entry.toolLifecycleStatus === "inProgress";
  if (item.kind === "text") return Boolean(item.message.streaming);
  return (item.row.subagents ?? [item.row.projectedItem]).some(({ item: member }) =>
    subagentItemIsLive(member.status),
  );
}

const WORKING_WINDOW_TAIL = 12;
const WORKING_WINDOW_COLLAPSED_HEIGHT = 220;

const WORKING_HISTORY_BATCH = 50;

const transitionsSettled = (element: HTMLElement | null) =>
  Promise.allSettled(element?.getAnimations().map((animation) => animation.finished) ?? []);

/**
 * One item, most important first: needs you, reconnecting, failed tests,
 * then the diff. Empty until there is something to show.
 */
function WorkingBarSlot({
  window,
  pendingRequest,
}: {
  window: WorkingWindow;
  pendingRequest: TimelinePendingRequest | null;
}) {
  const ctx = use(TimelineRowCtx);
  if (pendingRequest) {
    const Icon =
      pendingRequest.kind === "approval" ? ShieldQuestionMarkIcon : MessageCircleQuestionMarkIcon;
    const content = (
      <>
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{pendingRequest.label}</span>
      </>
    );
    // Both are answered in the composer. A question's answer goes in the
    // editor, so the slot focuses it; an approval uses the card's buttons,
    // which the editor cannot reach, so the slot only names it.
    const focusComposer = pendingRequest.kind === "question" ? ctx.onFocusComposer : null;
    const className = cn(
      "inline-flex h-[22px] min-w-0 shrink items-center gap-1.5 rounded-row text-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      pendingRequest.kind === "approval"
        ? "bg-warning-foreground/10 px-2 text-warning-foreground"
        : "text-info-foreground",
      focusComposer && "cursor-pointer",
    );
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            focusComposer ? (
              <WorkingBarControl variant="question" onClick={focusComposer} />
            ) : (
              <span className={className} />
            )
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup>
          <span className="block">{pendingRequest.label}</span>
          <span className="block">Answer in the composer</span>
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (window.retryAttempt !== null) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-meta text-warning-foreground">
        <RefreshCwIcon aria-hidden className="size-3" />
        <span>Reconnecting</span>
      </span>
    );
  }
  if (window.failedTests) {
    const count = window.failedTests.count;
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-meta text-error-foreground">
        <CircleXIcon aria-hidden className="size-3" />
        {count === null ? "Tests failed" : `${count} ${count === 1 ? "test" : "tests"} failed`}
      </span>
    );
  }
  return window.diff ? (
    <DiffStatBlocks additions={window.diff.additions} deletions={window.diff.deletions} />
  ) : null;
}

function subagentItemIsLive(status: OrchestrationV2TurnItem["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function workingWindowHasActiveCompaction(window: WorkingWindow | undefined): boolean {
  return (
    window?.items.some(
      (item) =>
        item.kind === "work" &&
        item.entry.sourceActivityKind === "context-compaction" &&
        item.entry.toolLifecycleStatus === "inProgress",
    ) ?? false
  );
}

/** A command sent on its own: the action's icon, what happened, and the command as a chip. */
export function SlashCommandTimelineRow({ command }: { command: TimelineSlashCommand }) {
  const ctx = use(TimelineRowCtx);
  const { activeTurnStartedAt } = use(TimelineRowActivityCtx);
  const { icon: Icon, verb, target } = presentSlashCommand(command, command.state, command.result);
  const skill = command.skill ? ctx.skills.find((entry) => entry.name === command.name) : undefined;
  const compacting = command.name === "compact" && !command.skill && command.state === "running";
  return (
    <WorkLogRow
      icon={<Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <WorkLogVerb
            tone={
              command.state === "failed" ? "error" : command.state === "done" ? "default" : "muted"
            }
          >
            {compacting && activeTurnStartedAt ? (
              <>
                Compacting for <WorkingTimer createdAt={activeTurnStartedAt} />
              </>
            ) : (
              verb
            )}
          </WorkLogVerb>
          {target ? <WorkLogTarget>{target}</WorkLogTarget> : null}
        </span>
      }
      trailing={
        command.skill ? (
          <SkillChipPopover
            label={formatProviderSkillDisplayName(skill ?? { name: command.name })}
            description={skill ? skillPopoverDescription(skill) : null}
            copyMarkdown={`${command.sigil}${command.name}`}
            onViewInstructions={skillInstructionsOpener(ctx.threadRef, skill)}
          />
        ) : (
          <SlashCommandChip name={command.name} />
        )
      }
    />
  );
}
