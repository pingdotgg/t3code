import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { canSettle, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import { displayThreadSubtitle } from "@t3tools/client-runtime/state/thread-subtitle";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import {
  AlarmClockOffIcon,
  ArrowUpRightIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState, type DragEvent } from "react";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import type { PrStatusIndicator } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";

interface SessionGridChatPaneProps {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly environmentLabel: string | null;
  readonly settlementSupported: boolean;
  readonly snoozed: boolean;
  readonly nowIso: string;
  readonly focused: boolean;
  readonly dragOver: boolean;
  readonly prStatus: PrStatusIndicator | null;
  readonly panelControlsPortalTarget: HTMLElement | null;
  readonly rightPanelPortalTarget: HTMLElement | null;
  readonly onFocus: (threadKey: string) => void;
  readonly onSettle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsnooze: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onDragStart: (threadKey: string, event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (threadKey: string) => void;
  readonly onDrop: (threadKey: string) => void;
  readonly onDragEnd: () => void;
}

function paneStatus(thread: EnvironmentThreadShell, snoozed: boolean, nowIso: string) {
  if (snoozed) {
    return {
      label: thread.snoozedUntil
        ? `Snoozed · ${snoozeWakeLabel(thread.snoozedUntil, { now: nowIso })}`
        : "Snoozed",
      className: "text-violet-600 dark:text-violet-300",
      dotClassName: "bg-violet-500",
      showLabelWithSubtitle: true,
    };
  }
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") {
    return {
      label: "Approval needed",
      className: "text-amber-700 dark:text-amber-300",
      dotClassName: "bg-amber-500",
      showLabelWithSubtitle: true,
    };
  }
  if (status === "input") {
    return {
      label: "Input needed",
      className: "text-indigo-700 dark:text-indigo-300",
      dotClassName: "bg-indigo-500",
      showLabelWithSubtitle: true,
    };
  }
  if (status === "working") {
    return {
      label: thread.session?.status === "starting" ? "Connecting" : "Working",
      className: "text-sky-700 dark:text-sky-300",
      dotClassName: "bg-sky-500",
      showLabelWithSubtitle: false,
    };
  }
  if (status === "failed") {
    return {
      label: "Run failed",
      className: "text-red-700 dark:text-red-300",
      dotClassName: "bg-red-500",
      showLabelWithSubtitle: true,
    };
  }
  return {
    label: "Ready",
    className: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/45",
    showLabelWithSubtitle: false,
  };
}

// fork: project session grid — the pane now embeds the complete canonical
// ChatView, including its composer, approvals, attachments, and panel state.
export const SessionGridChatPane = memo(function SessionGridChatPane(
  props: SessionGridChatPaneProps,
) {
  const { thread } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const subtitle = displayThreadSubtitle(thread);
  const routeParams = useMemo(() => buildThreadRouteParams(threadRef), [threadRef]);
  const status = paneStatus(thread, props.snoozed, props.nowIso);
  const headerTitle = [
    `Open ${thread.title}`,
    subtitle,
    status.label,
    thread.branch ? `Branch ${thread.branch}` : null,
    props.environmentLabel ? `Environment ${props.environmentLabel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const [leavingPending, setLeavingPending] = useState(false);
  const [runContextPortalTarget, setRunContextPortalTarget] = useState<HTMLElement | null>(null);
  const openPrLink = useOpenPrLink();
  const canSettleThread =
    !props.snoozed && props.settlementSupported && canSettle(thread, { now: props.nowIso });

  const leaveGrid = async (action: "settle" | "wake") => {
    if (leavingPending) return;
    setLeavingPending(true);
    const succeeded =
      action === "settle" ? await props.onSettle(thread) : await props.onUnsnooze(thread);
    if (!succeeded) setLeavingPending(false);
  };

  const header = (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        aria-label={`Reorder ${thread.title}`}
        className="flex shrink-0 cursor-grab touch-none items-center text-muted-foreground/55 active:cursor-grabbing"
        draggable
        onDragEnd={props.onDragEnd}
        onDragStart={(event) => props.onDragStart(threadKey, event)}
        role="button"
        tabIndex={-1}
        title="Drag to reorder"
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <ProjectFavicon
        className="size-3.5 shrink-0"
        cwd={props.project.workspaceRoot}
        environmentId={thread.environmentId}
      />
      <Link
        className="min-w-0 flex-1 outline-none"
        params={routeParams}
        title={headerTitle}
        to="/$environmentId/$threadId"
      >
        <div className="truncate text-xs font-semibold leading-4 text-foreground">
          {thread.title}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/70">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dotClassName)} />
          {subtitle ? (
            <>
              {status.showLabelWithSubtitle ? (
                <>
                  <span className={cn("shrink-0 text-[10px] leading-3", status.className)}>
                    {status.label}
                  </span>
                  <span aria-hidden className="text-[10px] leading-3">
                    ·
                  </span>
                </>
              ) : (
                <span className="sr-only">{status.label}. </span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground/80">
                {subtitle}
              </span>
            </>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3">
              <span className={cn("shrink-0", status.className)}>{status.label}</span>
              {thread.branch ? (
                <>
                  <span aria-hidden>·</span>
                  <GitBranchIcon className="size-2.5 shrink-0" />
                  <span className="truncate font-mono">{thread.branch}</span>
                </>
              ) : null}
              {props.environmentLabel ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{props.environmentLabel}</span>
                </>
              ) : null}
            </div>
          )}
        </div>
      </Link>
      <div
        ref={setRunContextPortalTarget}
        className="flex min-w-0 w-fit max-w-[42%] shrink-0 items-center justify-end"
      />
      {props.prStatus ? (
        <Button
          aria-label={props.prStatus.tooltip}
          className={cn("h-6 px-1.5 text-[10px]", props.prStatus.colorClass)}
          onClick={(event) => openPrLink(event, props.prStatus?.url ?? "")}
          size="xs"
          title={props.prStatus.tooltip}
          variant="ghost"
        >
          <GitPullRequestIcon className="size-3" />
          {props.prStatus.label}
        </Button>
      ) : null}
      <Button
        aria-label={`Open ${thread.title} in full chat`}
        render={<Link params={routeParams} to="/$environmentId/$threadId" />}
        size="icon-xs"
        title="Open full chat"
        variant="ghost"
      >
        <ArrowUpRightIcon />
      </Button>
      {props.snoozed ? (
        <Button
          aria-label={`Wake ${thread.title}`}
          disabled={leavingPending}
          onClick={() => void leaveGrid("wake")}
          size="icon-xs"
          title="Wake thread"
          variant="ghost"
        >
          <AlarmClockOffIcon />
        </Button>
      ) : canSettleThread ? (
        <Button
          aria-label={`Settle ${thread.title}`}
          disabled={leavingPending}
          onClick={() => void leaveGrid("settle")}
          size="icon-xs"
          title="Settle thread"
          variant="ghost"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );

  return (
    <section
      aria-label={`${thread.title} chat`}
      className={cn(
        "group/session-pane relative flex min-h-0 min-w-0 overflow-hidden rounded-xl border bg-background shadow-sm/5 outline-none",
        "ring-offset-2 ring-offset-zinc-900 focus-visible:ring-2 focus-visible:ring-ring/60 dark:ring-offset-black",
        props.focused && "border-foreground/20 shadow-sm/10",
        props.dragOver && "z-[2] ring-2 ring-ring/65",
        props.snoozed && "bg-muted/10",
      )}
      data-session-grid-pane
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onDragOver(threadKey);
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop(threadKey);
      }}
      onFocusCapture={() => props.onFocus(threadKey)}
      onPointerDownCapture={() => props.onFocus(threadKey)}
      tabIndex={0}
    >
      {props.focused ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 left-0 z-10 h-7 w-0.5 rounded-r-full bg-ring/65"
        />
      ) : null}
      <ChatView
        environmentId={thread.environmentId}
        gridHeader={header}
        gridRunContextPortalTarget={runContextPortalTarget}
        isActiveSurface={props.focused}
        panelControlsPortalTarget={props.panelControlsPortalTarget}
        reserveTitleBarControlInset={false}
        rightPanelPortalTarget={props.rightPanelPortalTarget}
        routeKind="server"
        surfaceMode="grid-pane"
        threadId={thread.id}
      />
    </section>
  );
});
