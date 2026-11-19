import { T, useGT, Var } from "gt-react";
import {
  ClockIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LinkIcon,
  ListTodoIcon,
  UserIcon,
} from "lucide-react";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatFullTimestamp } from "~/timestampFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The fixed title block: the title on one line with the header's actions, a line under it. */
export const PULL_REQUEST_DETAIL_HEADER_CLASS =
  "@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 py-3.5";

/** One key-value row of a detail header: an icon and label column, then the value. */
export function PullRequestMetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

/** "2h ago", with the full time on hover. */
export function PullRequestTimestamp({ timestamp }: { timestamp: string }) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={timestamp} />}>
        <RelativeTime timestamp={timestamp} />
      </TooltipTrigger>
      <TooltipPopup>{formatFullTimestamp(timestamp, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

/** An Orbit task a pull request came from. */
export interface PullRequestTaskLink {
  readonly number: number;
  readonly title: string;
  readonly onOpen: () => void;
}

export function PullRequestTaskRow({ task }: { task: PullRequestTaskLink }) {
  const gt = useGT();
  return (
    <PullRequestMetaRow
      icon={<ListTodoIcon aria-hidden className="size-3.5" />}
      label={gt("Task", { $context: "row label: the Orbit task a pull request came from" })}
    >
      <button
        type="button"
        onClick={task.onOpen}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left underline-offset-2 hover:underline"
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">#{task.number}</span>
        <span className="truncate">{task.title}</span>
      </button>
    </PullRequestMetaRow>
  );
}

/**
 * The key-value list under the title. `task` is the Orbit task the pull request came from, when
 * one is known; `children` adds rows after Changes (reviewers, labels).
 */
export function PullRequestDetailHeaderBody({
  repository,
  link,
  task,
  author,
  updated,
  base,
  head,
  files,
  diffStat,
  children,
}: {
  repository: ReactNode;
  link: ReactNode;
  task?: ReactNode;
  author: ReactNode;
  updated: ReactNode;
  base: ReactNode;
  head: ReactNode;
  files: ReactNode;
  diffStat: ReactNode;
  children?: ReactNode;
}) {
  const gt = useGT();
  return (
    <div className="min-w-0 space-y-2 px-4.5 py-4">
      <PullRequestMetaRow
        icon={<FolderGit2Icon aria-hidden className="size-3.5" />}
        label={gt("Repository")}
      >
        <span className="flex min-w-0 items-center">{repository}</span>
      </PullRequestMetaRow>
      <PullRequestMetaRow
        icon={<LinkIcon aria-hidden className="size-3.5" />}
        label={gt("Link", { $context: "row label: the pull request's address on its host" })}
      >
        <span className="flex min-w-0 items-center">{link}</span>
      </PullRequestMetaRow>
      {task}
      <PullRequestMetaRow icon={<UserIcon aria-hidden className="size-3.5" />} label={gt("Author")}>
        <span className="flex min-w-0 items-center">{author}</span>
      </PullRequestMetaRow>
      <PullRequestMetaRow
        icon={<ClockIcon aria-hidden className="size-3.5" />}
        label={gt("Updated at")}
      >
        <span className="text-muted-foreground">{updated}</span>
      </PullRequestMetaRow>
      <PullRequestMetaRow
        icon={<GitBranchIcon aria-hidden className="size-3.5" />}
        label={gt("Branch")}
      >
        {/* The head branch's copy button has its own padding; -ms-1 puts its text on the column. */}
        <span className="-ms-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <T context="the pull request's branch, then the branch it merges into">
            <Var>{head}</Var> <span className="shrink-0 text-muted-foreground/70">into</span>{" "}
            <Var>{base}</Var>
          </T>
        </span>
      </PullRequestMetaRow>
      <PullRequestMetaRow
        icon={<FileDiffIcon aria-hidden className="size-3.5" />}
        label={gt("Changes", { $context: "row label: changed files and lines" })}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="tabular-nums">{files}</span>
          {diffStat}
        </span>
      </PullRequestMetaRow>
      {children}
    </div>
  );
}

export function PullRequestDetailTitleRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-h-7 min-w-0 items-center sm:min-h-6", className)} {...props} />
  );
}

/**
 * Line tabs with the open tab's own actions at the right end of the row. The row is 47px between
 * its lines and sticks to the top of the panel's scroll area.
 */
export function PullRequestDetailTabBar<Tab extends string>({
  tabs,
  value,
  onValueChange,
  onTabIntent,
  inert,
  className,
  focusRequest = 0,
  children,
}: {
  tabs: ReadonlyArray<{ readonly value: Tab; readonly label: string }>;
  value: Tab;
  /** `keyboard` when arrow keys chose the tab, so the row that shows it next can take focus. */
  onValueChange?: (tab: Tab, source?: "keyboard") => void;
  /** Each new value moves focus to this row's active tab. */
  focusRequest?: number;
  onTabIntent?: (tab: Tab) => void;
  inert?: boolean;
  className?: string;
  /** The open tab's actions. */
  children?: ReactNode;
}) {
  const gt = useGT();
  // A pointer passing over a tab is not intent; it must rest like a list row does.
  const pointerIntent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A rest timer still pending when the bar unmounts must not read for a closed panel.
  useEffect(() => () => clearTimeout(pointerIntent.current), []);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each tab has its own row, so focus must move into the row that shows the newly chosen tab
  useEffect(() => {
    if (focusRequest === 0) return;
    tablistRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [focusRequest]);
  return (
    <nav
      className={cn(
        "flex h-12.25 min-w-0 shrink-0 items-center gap-3 border-y border-(--shell-divider) bg-background px-4.5",
        className,
      )}
      aria-label={gt("Pull request tabs")}
      inert={inert}
    >
      <div
        ref={tablistRef}
        role="tablist"
        className="flex shrink-0 items-center gap-5 self-stretch"
      >
        {tabs.map((tab) => {
          const active = tab.value === value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onValueChange?.(tab.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                const index = tabs.findIndex((item) => item.value === value);
                const next =
                  tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
                if (!next) return;
                onValueChange?.(next.value, "keyboard");
              }}
              onPointerEnter={
                onTabIntent
                  ? () => {
                      clearTimeout(pointerIntent.current);
                      pointerIntent.current = setTimeout(() => onTabIntent(tab.value), 150);
                    }
                  : undefined
              }
              onPointerLeave={onTabIntent ? () => clearTimeout(pointerIntent.current) : undefined}
              onFocus={onTabIntent ? () => onTabIntent(tab.value) : undefined}
              className={cn(
                "-mb-px flex cursor-pointer items-center self-stretch border-b-2 px-0.5 text-sm font-medium outline-none transition-colors focus-visible:text-foreground",
                active
                  ? "border-foreground/80 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground/85",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </nav>
  );
}

export function PullRequestChecksStatusLine({
  icon,
  label,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { icon: ReactNode; label: ReactNode }) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center justify-end gap-2 overflow-hidden text-ui text-foreground/85",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}
