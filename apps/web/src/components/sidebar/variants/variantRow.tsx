import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "../../../lib/visibleAnimation";
import { shouldShowInstanceBadge } from "../../../providerInstances";
import { ProviderInstanceIcon, providerTextColor } from "../../chat/ProviderInstanceIcon";
import type { SidebarThreadStatus } from "../../Sidebar.logic";
import { InlineRowAnswers, RowAnswersPopover } from "./RowAnswers";
import type { SidebarProviderEntry } from "../SidebarThreadRow";
import { rowAttention, workerTotal, type VariantRowStyle } from "./sidebarVariant.logic";

/** As tall as line 2, with the state colour mixed 14% into the row. */
export const ROW_PILL_CLASS_NAME =
  "sidebar-row-pill inline-flex shrink-0 items-center gap-1 rounded-full text-2xs font-semibold whitespace-nowrap";

const stopRowActivation = (event: MouseEvent) => event.stopPropagation();

/** The provider's logo in full colour, with initials when the provider has several instances. */
export function RowProviderMark(props: {
  entry: SidebarProviderEntry;
  entries: ReadonlyMap<string, SidebarProviderEntry>;
  className: string;
}) {
  const color = providerTextColor(props.entry.driverKind);
  return (
    <span className={cn("flex", color.className)} style={color.style}>
      <ProviderInstanceIcon
        driverKind={props.entry.driverKind}
        displayName={props.entry.displayName}
        accentColor={props.entry.accentColor}
        acpRegistryAgentId={props.entry.acpRegistryAgentId}
        acpRegistryIconUrl={props.entry.acpRegistryIconUrl}
        iconClassName={props.className}
        showBadge={shouldShowInstanceBadge(props.entry, props.entries.values())}
        indicatorBackground="var(--sidebar)"
        // why: on the 8px mark a corner badge would cover the whole logo.
        badgeClassName={cn(
          "h-2.5 min-w-2.5 px-px text-5xs",
          props.className === "size-2" ? "right-[calc(100%-2px)] bottom-0" : "-right-1 -bottom-1.5",
        )}
      />
    </span>
  );
}

function RowLead(props: {
  repo: ReactNode;
  mark: ((className: string) => ReactNode) | null;
}): ReactNode {
  return (
    <span aria-hidden className="relative size-3 shrink-0">
      {props.repo !== null ? (
        <>
          <span className="absolute -top-px -left-px flex size-3.5">{props.repo}</span>
          {props.mark ? (
            <span className="sidebar-row-disc absolute top-[0.40625rem] left-[0.40625rem] flex size-[0.6875rem] items-center justify-center rounded-full">
              {props.mark("size-2")}
            </span>
          ) : null}
        </>
      ) : props.mark ? (
        <span className="absolute -top-px -left-px flex size-3.5">{props.mark("size-3.5")}</span>
      ) : null}
    </span>
  );
}

/** The count on line 2 that folds a row's workers; the sidebar's arrow keys treat it as a row. */
export function WorkerFoldChip(props: {
  threadKey: string;
  open: boolean;
  summary: string;
  total: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-worker-fold
      data-sidebar-row={`workers:${props.threadKey}`}
      data-sidebar-parent={props.threadKey}
      aria-expanded={props.open}
      aria-label={props.summary}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      onDoubleClick={stopRowActivation}
      className="relative inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm font-medium text-muted-foreground outline-none after:absolute after:-inset-y-1 after:inset-x-0 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
          props.open && "rotate-90",
        )}
      />
      <span data-chip-full className="truncate">
        {props.summary}
      </span>
      <span data-chip-short className="truncate">
        {props.total}
      </span>
    </button>
  );
}

/** Detailed and Slim rows, where Slim is this row without line 2. */
export function resolveVariantRow(input: {
  style: VariantRowStyle;
  threadKey: string;
  thread: EnvironmentThreadShell;
  status: SidebarThreadStatus;
  statusWord: { label: string; className: string } | null;
  wokePill: ReactNode;
  time: ReactNode;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
  hasDraftSurface: boolean;
  nested: boolean;
  lastNested: boolean;
  inFolder: boolean;
  repo: ReactNode;
  mark: ((className: string) => ReactNode) | null;
  title: ReactNode;
  draft: ReactNode;
  pin: ReactNode;
  where: ReactNode;
  lineExtras: ReactNode;
  remote: ReactNode;
  terminal: ReactNode;
  jumpHint: ReactNode;
  workerCount: number | null;
  workerSummary: string | null;
  workersOpen: boolean | null;
  onToggleWorkers: () => void;
  answersOpen: boolean;
  onAnswersOpenChange: (open: boolean) => void;
  onOpenThread: () => void;
  statusSlot: (content: ReactNode, keepsLabel: boolean) => ReactNode;
}) {
  const { thread, status, statusWord, nested } = input;
  const working = status === "working" || status === "preparing";
  const asksYou = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const detailed = input.style === "folder-detailed";
  const answersInPopover = !detailed && asksYou;
  const attention = nested
    ? undefined
    : (rowAttention(status, input.isUnread) ?? (input.isWoke ? ("warning" as const) : undefined));

  const pill =
    input.wokePill ??
    (statusWord === null ? null : answersInPopover ? (
      <RowAnswersPopover
        thread={thread}
        label={statusWord.label}
        className={cn(ROW_PILL_CLASS_NAME, statusWord.className)}
        open={input.answersOpen}
        onOpenChange={input.onAnswersOpenChange}
        onOpenThread={input.onOpenThread}
      />
    ) : (
      <span className={cn(ROW_PILL_CLASS_NAME, statusWord.className)}>
        {working ? (
          <span
            aria-hidden
            ref={observeVisibleAnimation}
            className="sidebar-status-dot block size-1.5 shrink-0 rounded-full"
          />
        ) : null}
        <span className="sidebar-row-pill-word">{statusWord.label}</span>
      </span>
    ));

  const pinned = input.pin ? (
    <span className="inline-flex shrink-0 [&_svg]:size-[0.6875rem]">{input.pin}</span>
  ) : null;
  const lead = nested ? (
    <span aria-hidden className="flex size-3 shrink-0">
      {input.mark?.("size-3")}
    </span>
  ) : (
    <RowLead repo={input.repo} mark={input.mark} />
  );
  const lineOne = (
    <div
      data-row-line1
      className={cn(
        "flex min-w-0 items-center",
        nested ? "h-[1.125rem] gap-1.5" : "h-[1.21875rem] gap-2",
      )}
    >
      {lead}
      {input.title}
      {input.draft}
      {pinned}
      {nested ? input.terminal : null}
      {input.jumpHint}
      {!detailed ? (
        <>
          {input.workerCount !== null ? (
            <span
              role="img"
              aria-label={input.workerSummary ?? undefined}
              className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground tabular-nums"
            >
              <BotIcon aria-hidden className="size-3 shrink-0" />
              {input.workerCount}
            </span>
          ) : null}
          {input.terminal}
          {input.statusSlot(
            pill ?? <span className="text-2xs">{input.time}</span>,
            answersInPopover,
          )}
        </>
      ) : pill !== null ? (
        <span className="ml-auto flex shrink-0">{pill}</span>
      ) : null}
    </div>
  );

  const chip =
    input.workerCount === null ? null : input.workersOpen === null ? (
      <span
        aria-hidden
        data-worker-chip
        className="min-w-0 truncate font-medium text-muted-foreground"
      >
        {input.workerSummary}
      </span>
    ) : (
      <WorkerFoldChip
        threadKey={input.threadKey}
        open={input.workersOpen}
        summary={input.workerSummary ?? ""}
        total={workerTotal(input.workerCount)}
        onToggle={input.onToggleWorkers}
      />
    );

  const lineTwo =
    detailed && !nested ? (
      <div
        data-row-line2
        className="sidebar-row-line2 relative mt-1 ms-5 flex min-h-[1.03125rem] min-w-0 items-center gap-1.5 text-2xs"
      >
        {input.remote ? (
          <span aria-hidden className="absolute top-[0.140625rem] -left-5 flex size-3">
            {input.remote}
          </span>
        ) : null}
        {chip}
        {asksYou ? <InlineRowAnswers thread={thread} className="min-w-0 flex-1" /> : null}
        <span data-line2-rest className="contents">
          {input.workerCount !== null ? <span className="flex-1" /> : input.where}
        </span>
        {input.terminal}
        <span data-line2-rest className="contents">
          {input.lineExtras}
        </span>
        {input.statusSlot(input.time, false)}
      </div>
    ) : null;

  return {
    rowClassName: cn(
      "sidebar-variant-tokens sidebar-row-look",
      nested ? "rounded-md px-2 py-0.75" : "rounded-lg",
      !nested && (detailed ? "px-3 py-2" : "flex h-9 flex-col justify-center px-3"),
      !nested && (input.isActive || input.isSelected) && "sidebar-row-stroke ring-1 ring-inset",
    ),
    rootClassName: cn(
      nested
        ? "sidebar-worker-guide relative ms-3 -mt-px ps-6 [contain-intrinsic-size:auto_--spacing(6)]"
        : detailed
          ? "[contain-intrinsic-size:auto_--spacing(14)]"
          : "[contain-intrinsic-size:auto_--spacing(9)]",
      !nested && input.inFolder && "ms-3",
    ),
    rootAttributes: nested && input.lastNested ? { "data-last-worker": "" } : {},
    surface: nested
      ? input.isActive
        ? "worker-active"
        : input.isSelected
          ? "worker-selected"
          : undefined
      : input.isActive
        ? "active"
        : input.isSelected
          ? "selected"
          : input.hasDraftSurface
            ? "draft"
            : undefined,
    attention,
    labelSuffix: input.workerSummary !== null ? `, ${input.workerSummary}` : "",
    body: (
      <>
        {working && !nested ? (
          <span aria-hidden ref={observeVisibleAnimation} className="sidebar-row-sweep" />
        ) : null}
        {lineOne}
        {lineTwo}
        {nested && asksYou ? (
          <InlineRowAnswers thread={thread} className="mt-[0.1875rem] ms-[1.125rem]" />
        ) : null}
      </>
    ),
  };
}
