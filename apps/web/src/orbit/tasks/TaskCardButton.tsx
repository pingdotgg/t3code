import {
  orbitTaskLabel,
  orbitTaskLane,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";
import { useGT } from "gt-react";
import { ListTodoIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { ProjectMonogram } from "~/components/ProjectMonogram";
import { StatusDotBadge, type StatusDotState } from "~/components/StatusDotBadge";
import { resolvePullRequestState } from "~/components/pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { cn } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "~/projectIconColors";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";

import { taskCardDetail } from "./tasksBoard.logic";

/** Stands in for a favicon: Orbit Projects have no Conn project icon here. */
function TaskProjectIcon(props: { project: OrbitTaskSummary["project"] }) {
  const hash = [...props.project.slug].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const color = PROJECT_ICON_COLORS[hash % PROJECT_ICON_COLORS.length]!.value;
  return <ProjectMonogram text={(props.project.name[0] ?? "?").toUpperCase()} color={color} />;
}

/** The dot on the card's leading icon. Cancelled and unstarted tasks have none. */
export function taskStatusDot(task: OrbitTaskSummary): StatusDotState | null {
  if (task.attention?.kind === "question") return "waiting";
  const label = orbitTaskLabel(task);
  if (label?.tone === "destructive") return "failed";
  if (task.status === "cancelled") return null;
  if (task.status === "completed") return "done";
  return orbitTaskLane(task.status) === "in-progress" ? "working" : null;
}

/**
 * The time at the card's top right; the state is the dot on the icon. A task in progress shows how
 * long since it started (Orbit gives a list no run start, so its creation); others, the last activity.
 */
export function TaskCardStatus(props: { task: OrbitTaskSummary }) {
  const { task } = props;
  const label = orbitTaskLabel(task);
  const now = useNowMinute();
  const working = taskStatusDot(task) === "working";
  return (
    <span className="text-muted-foreground/80 tabular-nums">
      {label !== null ? <span className="sr-only">{label.label}</span> : null}
      {working
        ? formatWorkingDurationLabel(Date.parse(now) - Date.parse(task.createdAt))
        : formatRelativeTimeLabel(task.lastActivityAt ?? task.updatedAt)}
    </span>
  );
}

/** The task's PR as a number with its state icon, or null without a PR. */
export function taskCardPullRequest(task: OrbitTaskSummary) {
  const pr = task.pullRequest;
  if (!pr) return null;
  const state = pr.state ? resolvePullRequestState({ state: pr.state, isDraft: false }) : null;
  const badge = (
    <>
      {state ? (
        <state.Icon aria-hidden className="size-3.5" />
      ) : (
        <PullRequestGlyph.pullRequest className="size-3.5" />
      )}
      #{pr.number}
    </>
  );
  return { pr, state, badge };
}

/** The face every inline task card shares: a Task, a delegated subagent. */
export const TASK_CARD_FACE_CLASS =
  "flex w-full flex-col gap-1.5 rounded-lg border border-(--shell-divider)! border-t-(--shell-card-edge)! bg-(--shell-card) px-3 py-2.5 text-left [--task-card-fill:var(--shell-card)] dark:bg-(--shell-highlight)/70 dark:[--task-card-fill:color-mix(in_srgb,var(--foreground)_5.6%,var(--shell-card))]";

/** Added to the face when the card opens something. */
export const TASK_CARD_FACE_INTERACTIVE_CLASS =
  "cursor-pointer transition-colors hover:bg-(--shell-card)/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none dark:hover:bg-(--shell-highlight) dark:hover:[--task-card-fill:color-mix(in_srgb,var(--foreground)_8%,var(--shell-card))]";

/** The face's opaque fill (the dark card's 70% highlight laid over the panel), for a dot's ring. */
export const TASK_CARD_FILL = "var(--task-card-fill)";

/** The Tasks board's card face. The board lays its PR badge over it; the chat's receipt does not. */
export function TaskCardButton(props: {
  task: OrbitTaskSummary;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  /** Replaces the name the card's text gives it. */
  "aria-label"?: string;
}) {
  const { task } = props;
  const working = orbitTaskLane(task.status) === "in-progress" && task.attention === null;
  const detail = taskCardDetail(task);
  const badge = taskCardPullRequest(task)?.badge ?? null;
  return (
    <button
      type="button"
      aria-label={props["aria-label"]}
      onClick={props.onClick}
      // Insets match a sidebar thread row: icon 10px in, last text line 9px above the bottom.
      className={cn(
        TASK_CARD_FACE_CLASS,
        TASK_CARD_FACE_INTERACTIVE_CLASS,
        "px-2.25 pt-2.5 pb-2",
        props.className,
      )}
    >
      <span className="flex items-center gap-1.5 text-ui leading-4">
        <StatusDotBadge state={taskStatusDot(task)} ring={TASK_CARD_FILL}>
          <TaskProjectIcon project={task.project} />
        </StatusDotBadge>
        <span className="min-w-0 flex-1 truncate text-muted-foreground tabular-nums">
          #{task.id}
        </span>
        <span className="shrink-0">
          <TaskCardStatus task={task} />
        </span>
      </span>
      <span
        className={cn(
          "text-ui leading-5 text-foreground/90 [overflow-wrap:anywhere]",
          // Background work recedes to regular weight, like a working thread.
          working ? "font-normal" : "font-medium",
        )}
      >
        {task.title}
      </span>
      {/* With no subtask count, machine or PR the line goes. */}
      {detail || badge ? (
        <span className="flex items-center gap-2 text-ui leading-4 text-muted-foreground tabular-nums">
          <span className="min-w-0 flex-1 truncate">{detail}</span>
          {/* Holds the badge's place; the badge itself is its own button over the card. */}
          {badge ? (
            <span aria-hidden className="invisible flex shrink-0 items-center gap-1">
              {badge}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The task's PR badge, laid over the card's bottom right (the card holds its place). Its own
 * button: the card opens the task, the badge opens the PR. The card's parent must be `relative`.
 */
export function TaskCardPullRequestBadge(props: {
  task: OrbitTaskSummary;
  onOpen: (event: MouseEvent<HTMLButtonElement>, pullRequestUrl: string) => void;
}) {
  const gt = useGT();
  const pullRequest = taskCardPullRequest(props.task);
  if (!pullRequest) return null;
  return (
    <button
      type="button"
      onClick={(event) => props.onOpen(event, pullRequest.pr.url)}
      aria-label={
        pullRequest.state
          ? gt("Pull request #{number} ({state}). Open it in Tasks", {
              number: pullRequest.pr.number,
              state: pullRequest.state.label,
            })
          : gt("Pull request #{number}. Open it in Tasks", { number: pullRequest.pr.number })
      }
      className={cn(
        "absolute right-2.5 bottom-2.25 flex cursor-pointer items-center gap-1 rounded-sm text-ui leading-4 tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
        pullRequest.state?.toneClassName ?? "text-muted-foreground",
      )}
    >
      {pullRequest.badge}
    </button>
  );
}

/**
 * A task as a two-line row: project badge with the status dot and the title on one line, then
 * "project · #id · 1/4 · 52m · node · PR" under the title. Plain by default for compact lists;
 * pass `card` for the inline chat receipt so it shares the subagent card's boxed face. The whole
 * row opens the task through a button laid under the text; the PR is its own button on top of that.
 */
export function TaskRow(props: {
  task: OrbitTaskSummary;
  onOpen: () => void;
  onOpenPullRequest: (url: string) => void;
  /** Render with the boxed card face used by inline chat cards. */
  card?: boolean;
  className?: string;
}) {
  const { task, card = false } = props;
  const gt = useGT();
  const working = orbitTaskLane(task.status) === "in-progress" && task.attention === null;
  const { total, completed } = task.subtaskCounts;
  const node = task.workspace?.node?.name;
  const pullRequest = taskCardPullRequest(task);
  return (
    <div
      className={cn(
        "group/task-row relative min-w-0",
        card
          ? cn(TASK_CARD_FACE_CLASS, TASK_CARD_FACE_INTERACTIVE_CLASS, "gap-1 px-2.25 pt-2.5 pb-3")
          : "rounded-lg px-1 py-1.5 hover:bg-foreground/4 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring has-[button:focus-visible]:ring-inset",
        props.className,
      )}
    >
      <button
        type="button"
        aria-label={gt("Task #{id}: {title}. Open in Tasks", { id: task.id, title: task.title })}
        onClick={props.onOpen}
        className={cn(
          "absolute inset-0 cursor-pointer rounded-lg outline-none",
          card && "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      />
      <div
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-col",
          card ? "gap-1" : "gap-0.5",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 text-ui leading-5">
          <StatusDotBadge state={taskStatusDot(task)} ring={card ? TASK_CARD_FILL : undefined}>
            {card ? (
              <ListTodoIcon aria-hidden className="size-4 text-muted-foreground" />
            ) : (
              <TaskProjectIcon project={task.project} />
            )}
          </StatusDotBadge>
          <span
            className={cn(
              "min-w-0 flex-1 text-foreground",
              card ? "[overflow-wrap:anywhere]" : "truncate",
              working ? "font-normal" : "font-medium",
            )}
          >
            {task.title}
          </span>
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center ps-5.5 text-muted-foreground tabular-nums",
            card ? "text-ui" : "text-xs",
            "leading-4",
          )}
        >
          <span className="min-w-0 truncate">
            {task.project.slug} · #{task.id}
            {total >= 2 ? ` · ${completed}/${total}` : ""} · <TaskCardStatus task={task} />
            {node ? ` · ${node}` : ""}
          </span>
          {pullRequest ? (
            <>
              <span aria-hidden className="px-1">
                ·
              </span>
              <button
                type="button"
                onClick={() => props.onOpenPullRequest(pullRequest.pr.url)}
                aria-label={
                  pullRequest.state
                    ? gt("Pull request #{number} ({state}). Open it in Tasks", {
                        number: pullRequest.pr.number,
                        state: pullRequest.state.label,
                      })
                    : gt("Pull request #{number}. Open it in Tasks", {
                        number: pullRequest.pr.number,
                      })
                }
                className={cn(
                  "pointer-events-auto flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
                  pullRequest.state?.toneClassName ?? "text-muted-foreground",
                )}
              >
                {pullRequest.badge}
              </button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
