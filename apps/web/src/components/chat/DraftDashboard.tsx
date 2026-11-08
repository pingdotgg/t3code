import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDaysIcon, HistoryIcon, SquareActivityIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useVisibleThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { DASHBOARD_WEEKS, deriveDraftDashboard } from "./draftDashboard.logic";

const RECENT_LIMIT = 4;
const PULL_REQUEST_LIMIT = 3;
const HEAT_CLASSES = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"];

const heatLevel = (count: number, max: number) =>
  count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));

function Card({
  icon,
  title,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-foreground/8 bg-foreground/3 p-4 text-foreground backdrop-blur-xl",
        className,
      )}
    >
      <h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Delta({ current, previous }: { current: number; previous: number }) {
  const delta = current - previous;
  if (delta === 0) return null;
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        delta > 0 ? "text-diff-addition-foreground" : "text-diff-deletion-foreground",
      )}
    >
      {delta > 0 ? `+${delta}` : delta}
    </span>
  );
}

export function DraftDashboard() {
  const navigate = useNavigate();
  const threads = useVisibleThreadShells();
  const nowMs = Date.parse(useNowMinute());
  const data = deriveDraftDashboard(threads, nowMs);
  if (data.recent.length === 0) return null;

  const openThread = (thread: EnvironmentThreadShell) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  const maxPerDay = Math.max(1, ...data.activity);
  const firstWeekStart = new Date(nowMs - (DASHBOARD_WEEKS * 7 - 1) * 86_400_000);
  const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });

  return (
    <div className="grid grid-cols-3 gap-3 pt-6 pb-10">
      <Card icon={<SquareActivityIcon />} title="Activity" className="col-span-2">
        <div className="grid grid-flow-col grid-rows-7 gap-0.75" aria-hidden>
          {data.activity.map((count, index) => (
            <span
              // Cells are positional; the array never reorders.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={cn("aspect-square rounded-xs", HEAT_CLASSES[heatLevel(count, maxPerDay)])}
            />
          ))}
        </div>
        <p className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>
            {data.activityTotal} sessions · {data.pullRequests.length} PRs linked
          </span>
          <span>
            {monthFormat.format(firstWeekStart)} – {monthFormat.format(nowMs)}
          </span>
        </p>
      </Card>

      <Card icon={<HistoryIcon />} title="Recent sessions">
        <ul className="flex flex-col gap-2">
          {data.recent.slice(0, RECENT_LIMIT).map((thread) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <button
                type="button"
                onClick={() => openThread(thread)}
                className="flex w-full min-w-0 flex-col rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="truncate text-sm hover:underline">{thread.title}</span>
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt, nowMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {data.recent.length > RECENT_LIMIT ? (
          <p className="mt-auto text-xs text-muted-foreground">
            {data.recent.length - RECENT_LIMIT} more
          </p>
        ) : null}
      </Card>

      <Card icon={<PullRequestGlyph.pullRequest />} title="Pull requests" className="col-span-2">
        {data.pullRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pull requests linked to threads yet.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {data.pullRequests.slice(0, PULL_REQUEST_LIMIT).map(({ link, thread, at }) => {
              const snapshot = link.snapshot!;
              const presentation =
                PULL_REQUEST_STATE_PRESENTATION[
                  snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state
                ];
              return (
                <li key={link.url}>
                  <button
                    type="button"
                    onClick={() => openThread(thread)}
                    className="flex w-full min-w-0 items-start gap-2 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <presentation.Icon
                      aria-label={presentation.label}
                      className={cn("mt-0.5 size-3.5 shrink-0", presentation.toneClassName)}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm hover:underline">{snapshot.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTimeLabel(at, nowMs)}
                        {snapshot.author ? ` · ${snapshot.author.login}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {data.pullRequests.length > PULL_REQUEST_LIMIT ? (
          <p className="mt-auto text-xs text-muted-foreground">
            {data.pullRequests.length - PULL_REQUEST_LIMIT} more
          </p>
        ) : null}
      </Card>

      <Card icon={<CalendarDaysIcon />} title="This month">
        <dl className="flex flex-col gap-3">
          <div>
            <dt className="text-xs text-muted-foreground">Sessions</dt>
            <dd className="flex items-baseline gap-2">
              <span className="text-2xl font-medium tabular-nums">{data.sessionsThisMonth}</span>
              <Delta current={data.sessionsThisMonth} previous={data.sessionsLastMonth} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">PRs merged</dt>
            <dd className="flex items-baseline gap-2">
              <span className="text-2xl font-medium tabular-nums">{data.mergedThisMonth}</span>
              <Delta current={data.mergedThisMonth} previous={data.mergedLastMonth} />
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
