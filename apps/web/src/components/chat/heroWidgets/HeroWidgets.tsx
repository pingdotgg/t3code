import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScheduledTask } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import {
  ActivityIcon,
  CalendarClockIcon,
  ChartBarIcon,
  CircleDollarSignIcon,
  ClockIcon,
  DatabaseIcon,
  MonitorIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { environmentAtomList, environmentIdsKey } from "../../../state/environmentAtomList";
import { useProjects, useQuietThreadShells } from "../../../state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "../../../state/environments";
import { usePullRequestList } from "../../../state/pullRequests";
import { serverEnvironment } from "../../../state/server";
import { useUsage } from "../../../state/usage";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { resolveThreadStatusPill, resolveWorkingStartedAt } from "../../Sidebar.logic";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { PROVIDER_PRESENTATION } from "../../usage/usageProviders";
import { DitherCanvas } from "./DitherCanvas";
import { drawDitherArea, drawDitherField, drawDottedLine } from "./dither";
import {
  buildPunchcard,
  buildSpendSeries,
  fitWidgetGrid,
  formatHour,
  hourlyDayWindows,
  monthToDateWindow,
} from "./heroWidgets.logic";

const ACCENT = "var(--primary)";
const ACCENT_SOFT = "color-mix(in oklab, var(--primary) 55%, var(--foreground))";
const GHOST = "color-mix(in oklab, var(--foreground) 8%, transparent)";
const WARNING = "var(--warning)";
const SUCCESS = "var(--success)";
const DANGER = "var(--destructive)";
const PUNCHCARD_DAYS = 7;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer that keeps elapsed labels and the timeline's now-line current
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function WidgetCard({
  id,
  icon: Icon,
  title,
  meta,
  metaTone,
  className,
  children,
}: {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly meta?: ReactNode;
  readonly metaTone?: "warning" | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-hero-widget={id}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card/85 p-4 text-card-foreground shadow-xs backdrop-blur-sm",
        className,
      )}
    >
      <header className="flex items-center gap-2 text-sm">
        <Icon className="size-4 shrink-0 opacity-80" aria-hidden />
        <h3 className="font-medium">{title}</h3>
        {meta ? (
          <span
            className={cn(
              "ms-auto truncate text-xs",
              metaTone === "warning" ? "text-warning" : "text-muted-foreground",
            )}
          >
            {meta}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function BigNumber({ value, unit, aside }: { value: string; unit?: string; aside?: ReactNode }) {
  return (
    <div className="mt-3 mb-2 flex items-baseline gap-1.5 leading-none">
      <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
      {aside ? <span className="ms-auto text-xs tabular-nums">{aside}</span> : null}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs text-muted-foreground">{children}</p>;
}

function Axis({ labels, className }: { labels: ReadonlyArray<string>; className?: string }) {
  return (
    <div
      className={cn(
        "mt-1.5 flex justify-between text-3xs tracking-wider text-muted-foreground uppercase",
        className,
      )}
    >
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

function isOpenThread(thread: EnvironmentThreadShell): boolean {
  return thread.archivedAt === null && thread.deletedAt === null;
}

function RunningNowWidget({ now, roomy }: { now: number; roomy: boolean }) {
  const threads = useQuietThreadShells();
  const projects = useProjects();
  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const rows = threads
    .filter(isOpenThread)
    .flatMap((thread) => {
      const pill = resolveThreadStatusPill({ thread });
      if (!pill) return [];
      const needsYou = pill.label === "Pending Approval" || pill.label === "Awaiting Input";
      const working = pill.label === "Working" || pill.label === "Connecting";
      if (!needsYou && !working) return [];
      const startedAt = resolveWorkingStartedAt(thread);
      const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
      return [{ thread, pill, needsYou, startedMs }];
    })
    .toSorted((a, b) =>
      a.needsYou !== b.needsYou ? (a.needsYou ? -1 : 1) : (a.startedMs || 0) - (b.startedMs || 0),
    );
  const needsYouCount = rows.filter((row) => row.needsYou).length;

  return (
    <WidgetCard
      id="running"
      icon={ActivityIcon}
      title="Running now"
      meta={
        needsYouCount > 0
          ? `${needsYouCount} need${needsYouCount === 1 ? "s" : ""} you`
          : `${rows.length} working`
      }
      metaTone={needsYouCount > 0 ? "warning" : undefined}
    >
      {rows.length === 0 ? (
        <Empty>No agents are running.</Empty>
      ) : (
        <ul className="mt-2 divide-y divide-border/60">
          {rows.slice(0, roomy ? 4 : 3).map(({ thread, pill, startedMs }) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
                className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 py-2 text-xs hover:opacity-80"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-xs",
                    pill.dotClass,
                    pill.pulse && "animate-pulse",
                  )}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{thread.title}</span>
                  <span className="block truncate text-muted-foreground">
                    {projectTitles.get(`${thread.environmentId}:${thread.projectId}`) ??
                      "No project"}
                    {" · "}
                    {thread.modelSelection.model}
                  </span>
                </span>
                <span className={cn("tabular-nums", pill.colorClass)}>
                  {Number.isFinite(startedMs)
                    ? formatWorkingDurationLabel(Math.max(0, now - startedMs))
                    : pill.label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function CacheWidget({ usage }: { usage: MergedUsage | null }) {
  const input = usage
    ? usage.cachedInputTokens + usage.cacheCreationTokens + usage.uncachedInputTokens
    : 0;
  const segments = usage
    ? [
        { label: "Cache read", value: usage.cachedInputTokens, color: ACCENT_SOFT },
        { label: "Cache write", value: usage.cacheCreationTokens, color: ACCENT },
        {
          label: "Input",
          value: usage.uncachedInputTokens,
          color: PROVIDER_PRESENTATION.claude.color,
        },
        { label: "Output", value: usage.outputTokens, color: "var(--foreground)" },
      ].filter((segment) => segment.value > 0)
    : [];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <WidgetCard id="cache" icon={DatabaseIcon} title="Cache" meta="this month">
      {usage === null || input === 0 ? (
        <Empty>No usage recorded this month.</Empty>
      ) : (
        <>
          <BigNumber
            value={`${Math.round((usage.cachedInputTokens / input) * 100)}%`}
            unit="of input from cache"
            aside={`saved ${formatUsd(usage.costQuality.cacheSavingsUsd)}`}
          />
          <DitherCanvas
            className="h-6"
            label="Token mix"
            draw={(context, { width, height }, color) => {
              let x = 0;
              segments.forEach((segment, index) => {
                const segmentWidth = Math.max(
                  9,
                  Math.round((width * segment.value) / total / 3) * 3,
                );
                const span = Math.min(segmentWidth, width - x) - 3;
                const columns = span / 3;
                drawDitherField(
                  context,
                  { x, y: 0, width: span, height },
                  (column) => (index === 0 ? 1 - (column / columns) * 0.55 : 0.95),
                  color(segment.color),
                );
                x += segmentWidth;
              });
            }}
          />
          <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-2xs">
            {segments.map((segment) => (
              <span key={segment.label} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 rounded-xs"
                  style={{ background: segment.color }}
                />
                {segment.label}
                <span className="text-muted-foreground">{formatTokens(segment.value)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </WidgetCard>
  );
}

function useWeekOfHourly() {
  // One window per day: the server caps hourly windows at 24h.
  const [windows] = useState(() => hourlyDayWindows(new Date(), PUNCHCARD_DAYS));
  const views = [
    useUsage(windows[0]!),
    useUsage(windows[1]!),
    useUsage(windows[2]!),
    useUsage(windows[3]!),
    useUsage(windows[4]!),
    useUsage(windows[5]!),
    useUsage(windows[6]!),
  ];
  return views.flatMap((view) => (view.shown?.merged ?? view.merged)?.hourly ?? []);
}

function WhenYouWorkWidget({ now }: { now: number }) {
  const hourly = useWeekOfHourly();
  const punchcard = buildPunchcard(new Date(now), PUNCHCARD_DAYS, hourly);

  return (
    <WidgetCard
      id="when"
      icon={ClockIcon}
      title="When you work"
      meta={
        punchcard.peak
          ? `peak ${punchcard.peak.label} ${formatHour(punchcard.peak.hour)}`
          : "last 7 days"
      }
    >
      <div className="mt-3 grid min-h-24 flex-1 grid-cols-[28px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-1.5">
        <div
          className="grid h-full text-3xs text-muted-foreground"
          style={{ gridTemplateRows: `repeat(${PUNCHCARD_DAYS}, 1fr)` }}
        >
          {punchcard.rows.map((row) => (
            <span key={row.label} className="flex items-center">
              {row.label}
            </span>
          ))}
        </div>
        <DitherCanvas
          className="h-full min-h-0"
          label="Tokens by hour over the last 7 days"
          draw={(context, { width, height }, color) => {
            const cellWidth = width / 24;
            const cellHeight = height / PUNCHCARD_DAYS;
            const lit = color(ACCENT);
            const hot = color(ACCENT_SOFT);
            const ghost = color(GHOST);
            punchcard.rows.forEach((row, rowIndex) =>
              row.hours.forEach((tokens, hour) => {
                const value = punchcard.max > 0 ? Math.pow(tokens / punchcard.max, 0.6) : 0;
                drawDitherField(
                  context,
                  {
                    x: Math.floor(hour * cellWidth),
                    y: Math.floor(rowIndex * cellHeight),
                    width: Math.floor(cellWidth) - 2,
                    height: Math.floor(cellHeight) - 2,
                  },
                  value,
                  value > 0.8 ? hot : lit,
                  { ghost },
                );
              }),
            );
          }}
        />
      </div>
      <Axis className="ms-[34px]" labels={["12 AM", "6 AM", "12 PM", "6 PM", "Midnight"]} />
    </WidgetCard>
  );
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function SpendWidget({ usage, now: nowMs }: { usage: MergedUsage | null; now: number }) {
  const now = new Date(nowMs);
  const series = buildSpendSeries(now, usage?.daily ?? []);
  const scale = Math.max(series.pace, series.monthToDate) * 1.1 || 1;
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), series.daysInMonth);

  return (
    <WidgetCard id="spend" icon={CircleDollarSignIcon} title="Spend" meta="this month">
      <BigNumber
        value={formatUsd(series.monthToDate)}
        unit="so far"
        aside={<span className="text-muted-foreground">pace {formatUsd(series.pace)}</span>}
      />
      <DitherCanvas
        className="min-h-20 flex-1"
        label={`Spend this month, ${formatUsd(series.monthToDate)} so far`}
        draw={(context, { width, height }, color) => {
          const todayX = (width * series.cumulative.length) / series.daysInMonth;
          drawDitherArea(
            context,
            height,
            series.cumulative.map((value) => value / scale),
            { color: color(ACCENT), crest: color(ACCENT_SOFT), x0: 0, x1: todayX },
          );
          drawDottedLine(
            context,
            [todayX, height * (1 - series.monthToDate / scale)],
            [width - 2, height * (1 - series.pace / scale)],
            color(ACCENT_SOFT),
            5,
          );
          drawDottedLine(context, [todayX, 0], [todayX, height], color(GHOST), 3, 1);
        }}
      />
      <Axis
        labels={[
          MONTH_DAY.format(new Date(now.getFullYear(), now.getMonth(), 1)),
          "now",
          MONTH_DAY.format(monthEnd),
        ]}
      />
    </WidgetCard>
  );
}

const CHECK_TONE = { passing: SUCCESS, failing: DANGER, pending: WARNING } as const;

function PullRequestsWidget({ roomy }: { roomy: boolean }) {
  const environmentIds = useConnectedEnvironmentIds();
  const { data, isPending } = usePullRequestList(
    environmentIds.map((environmentId) => ({
      environmentId,
      input: { state: "open", involvement: "authored", limit: 20 },
    })),
  );
  const entries = (data?.entries ?? []).toSorted((a, b) => {
    const rank = (entry: typeof a) =>
      entry.viewerReviewRequested ? 0 : entry.checksState === "failing" ? 1 : 2;
    return rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const toReview = entries.filter((entry) => entry.viewerReviewRequested).length;

  return (
    <WidgetCard
      id="pull-requests"
      icon={PullRequestGlyph.pullRequest}
      title="Pull requests"
      meta={`${entries.length} open${toReview > 0 ? ` · ${toReview} to review` : ""}`}
    >
      {entries.length === 0 ? (
        <Empty>{isPending ? "Loading pull requests…" : "No open pull requests."}</Empty>
      ) : (
        <ul className="mt-2 divide-y divide-border/60">
          {entries.slice(0, roomy ? 4 : 3).map((entry) => (
            <li key={`${entry.environmentId}:${entry.url}`}>
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2 text-xs hover:opacity-80"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{entry.title}</span>
                  <span className="block truncate text-muted-foreground">
                    #{entry.number} · {entry.projectTitle}
                    {entry.isDraft ? " · draft" : ""}
                    {entry.viewerReviewRequested ? (
                      <span className="text-warning"> · needs your review</span>
                    ) : entry.reviewDecision === "changes-requested" ? (
                      " · changes requested"
                    ) : entry.reviewDecision === "approved" ? (
                      " · approved"
                    ) : null}
                  </span>
                </span>
                <span
                  className="inline-flex items-center gap-1.5 tabular-nums"
                  style={{ color: entry.checksState ? CHECK_TONE[entry.checksState] : undefined }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-2.5 w-1.5 rounded-xs bg-current",
                      entry.checksState === "pending" && "animate-pulse",
                    )}
                  />
                  {entry.checksState === "failing"
                    ? "failing"
                    : entry.checksState === "pending"
                      ? "running"
                      : entry.checksState === "passing"
                        ? "passing"
                        : "no checks"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function MachinesWidget({ roomy }: { roomy: boolean }) {
  const { environments } = useEnvironments();
  const threads = useQuietThreadShells();
  const running = new Map<string, number>();
  const total = new Map<string, number>();
  for (const thread of threads) {
    if (!isOpenThread(thread)) continue;
    total.set(thread.environmentId, (total.get(thread.environmentId) ?? 0) + 1);
    const pill = resolveThreadStatusPill({ thread });
    if (pill?.label === "Working" || pill?.label === "Connecting") {
      running.set(thread.environmentId, (running.get(thread.environmentId) ?? 0) + 1);
    }
  }
  const busiest = Math.max(1, ...running.values());
  const online = environments.filter((environment) => environment.connection.phase === "connected");

  return (
    <WidgetCard
      id="machines"
      icon={MonitorIcon}
      title="Machines"
      meta={`${online.length} of ${environments.length} online`}
    >
      <ul className="mt-2 divide-y divide-border/60">
        {environments.slice(0, roomy ? 4 : 3).map((environment) => {
          const connected = environment.connection.phase === "connected";
          const agents = running.get(environment.environmentId) ?? 0;
          return (
            <li
              key={environment.environmentId}
              className="grid grid-cols-[8px_minmax(0,1fr)_64px] items-center gap-2.5 py-2 text-xs"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-xs",
                  connected ? "bg-success" : "bg-muted-foreground/40",
                  environment.connection.phase === "connecting" && "animate-pulse",
                )}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{environment.label}</span>
                <span className="block truncate text-muted-foreground">
                  {connected
                    ? `${agents} running · ${total.get(environment.environmentId) ?? 0} threads`
                    : environment.connection.phase}
                </span>
              </span>
              <DitherCanvas
                className="h-3"
                draw={(context, { width, height }, color) =>
                  drawDitherField(
                    context,
                    { x: 0, y: 0, width, height },
                    (column) => (column * 3 < (width * agents) / busiest ? 0.95 : 0),
                    color(connected ? ACCENT : GHOST),
                    { ghost: color(GHOST) },
                  )
                }
              />
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}

function ModelsWidget({ usage, roomy }: { usage: MergedUsage | null; roomy: boolean }) {
  const models = (usage?.models ?? [])
    .toSorted((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, roomy ? 7 : 5);
  const top = models[0]?.totalTokens ?? 1;

  return (
    <WidgetCard id="models" icon={ChartBarIcon} title="Models" meta="this month · tokens">
      {models.length === 0 ? (
        <Empty>No usage recorded this month.</Empty>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {models.map((model) => (
            <li
              key={`${model.provider}:${model.model}`}
              className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem] items-center gap-2.5 text-xs"
            >
              <span className="truncate">{model.model}</span>
              <DitherCanvas
                className="h-3"
                draw={(context, { width, height }, color) => {
                  const filled = Math.max(3, (width * model.totalTokens) / top);
                  drawDitherField(
                    context,
                    { x: 0, y: 0, width, height },
                    (column) => (column * 3 < filled ? 1 - ((column * 3) / filled) * 0.5 : 0),
                    color(PROVIDER_PRESENTATION[model.provider]?.color ?? ACCENT),
                    { ghost: color(GHOST) },
                  );
                }}
              />
              <span className="text-right text-muted-foreground tabular-nums">
                {formatTokens(model.totalTokens)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

const scheduledTasksListAtom = environmentAtomList(
  "hero-widgets-scheduled-tasks",
  (environmentId) => serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY_MS = 24 * 60 * 60 * 1000;

function UpNextWidget({ now, roomy }: { now: number; roomy: boolean }) {
  const environmentIds = useConnectedEnvironmentIds();
  const queries = useAtomValue(scheduledTasksListAtom(environmentIdsKey(environmentIds)));
  const tasks = queries.flatMap(
    (query) =>
      AsyncResult.getOrElse(query, () => null)?.tasks ?? ([] as ReadonlyArray<ScheduledTask>),
  );
  const upcoming = tasks
    .flatMap((task) => {
      if (!task.enabled || task.nextRunAt === null) return [];
      const at = Date.parse(task.nextRunAt);
      return Number.isFinite(at) && at >= now ? [{ task, at }] : [];
    })
    .toSorted((a, b) => a.at - b.at);
  const threads = useQuietThreadShells();
  const watched = threads.flatMap((thread) =>
    isOpenThread(thread)
      ? thread.pullRequests
          .filter((link) => link.watch !== undefined)
          .map((link) => ({ thread, link }))
      : [],
  );
  const inDay = upcoming.filter((item) => item.at - now <= DAY_MS);

  return (
    <WidgetCard
      id="up-next"
      icon={CalendarClockIcon}
      title="Up next"
      meta={`${upcoming.length} scheduled · ${watched.length} PR waits`}
    >
      <DitherCanvas
        className="mt-3 h-8"
        label={`${inDay.length} scheduled runs in the next 24 hours`}
        draw={(context, { width, height }, color) => {
          const mid = Math.floor(height / 2);
          drawDitherField(context, { x: 0, y: mid - 4, width, height: 9 }, 0.22, color(GHOST));
          for (let hour = 0; hour <= 24; hour += 1) {
            context.fillStyle = color(hour % 6 === 0 ? ACCENT : GHOST);
            const tick = hour % 6 === 0 ? 6 : 2;
            context.fillRect(Math.min(width - 2, (hour / 24) * width), mid - tick, 2, tick * 2);
          }
          const marker = color(ACCENT_SOFT);
          for (const item of inDay) {
            const x = ((item.at - now) / DAY_MS) * width;
            context.fillStyle = marker;
            context.fillRect(x - 4, mid - 4, 8, 8);
            context.clearRect(x - 2, mid - 2, 4, 4);
            context.fillRect(x - 1, mid - 1, 2, 2);
          }
          drawDottedLine(context, [1, 0], [1, height], color("var(--foreground)"), 3, 2);
        }}
      />
      <Axis labels={["now", "+6h", "+12h", "+18h", "+24h"]} />
      {upcoming.length === 0 && watched.length === 0 ? (
        <Empty>Nothing scheduled.</Empty>
      ) : (
        <ul className="mt-2 flex flex-col">
          {upcoming.slice(0, roomy ? 3 : 2).map(({ task, at }) => (
            <li
              key={task.id}
              className="grid grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-2 py-1 text-xs"
            >
              <span className="text-muted-foreground tabular-nums">
                {at - now > DAY_MS ? MONTH_DAY.format(at) : CLOCK.format(at)}
              </span>
              <span className="truncate">{task.title}</span>
              <span className="rounded-md border px-1.5 text-3xs text-muted-foreground">task</span>
            </li>
          ))}
          {watched
            .slice(0, Math.max(0, (roomy ? 3 : 2) - upcoming.length))
            .map(({ thread, link }) => (
              <li
                key={`${thread.environmentId}:${thread.id}:${link.url}`}
                className="grid grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-2 py-1 text-xs"
              >
                <span className="text-muted-foreground">watching</span>
                <span className="truncate">
                  #{link.number} {thread.title}
                </span>
                <span className="rounded-md border px-1.5 text-3xs text-warning">PR wait</span>
              </li>
            ))}
        </ul>
      )}
    </WidgetCard>
  );
}

const WIDGETS_BY_PRIORITY: ReadonlyArray<{
  readonly id: string;
  readonly render: (data: { now: number; usage: MergedUsage | null; roomy: boolean }) => ReactNode;
}> = [
  { id: "running", render: ({ now, roomy }) => <RunningNowWidget now={now} roomy={roomy} /> },
  { id: "spend", render: ({ now, usage }) => <SpendWidget usage={usage} now={now} /> },
  { id: "cache", render: ({ usage }) => <CacheWidget usage={usage} /> },
  { id: "pull-requests", render: ({ roomy }) => <PullRequestsWidget roomy={roomy} /> },
  { id: "models", render: ({ usage, roomy }) => <ModelsWidget usage={usage} roomy={roomy} /> },
  { id: "when", render: ({ now }) => <WhenYouWorkWidget now={now} /> },
  { id: "machines", render: ({ roomy }) => <MachinesWidget roomy={roomy} /> },
  { id: "up-next", render: ({ now, roomy }) => <UpNextWidget now={now} roomy={roomy} /> },
];

/** Horizontal breathing room between the widget grid and the edges of the chat pane. */
const PANE_GUTTER = 48;
/** Space between the composer row and the widget grid. */
const GAP_ABOVE = 32;
/** Least room left for the hero headline, which fills the pane above the composer. */
const HEADLINE_SPACE = 112;
/** Space kept between the widget grid and the bottom of the pane. */
const EDGE_MARGIN = 24;
/** Cards grow into the space below the centered block up to this row height. */
const TALL_ROW_HEIGHT = 300;
/** Rows at least this tall show one more list item. */
const ROOMY_ROW_HEIGHT = 270;
const GRID_GAP = 10;

/**
 * Widgets under the new-chat composer. The grid spans the whole chat pane, never scrolls, and
 * shows the highest-priority widgets that fit. It reserves its height as bottom margin on the
 * composer stack (a CSS variable on the overlay), lifting the bottom-docked composer above it.
 */
export function HeroWidgets() {
  const now = useNow(30_000);
  const [monthWindow] = useState(() => monthToDateWindow(new Date()));
  const monthUsage = useUsage(monthWindow);
  const usage = monthUsage.shown?.merged ?? monthUsage.merged;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [space, setSpace] = useState<{ width: number; height: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sizes the grid to the chat pane left around the composer
  useLayoutEffect(() => {
    const container = containerRef.current;
    const stack = container?.parentElement;
    const overlay = container?.closest<HTMLElement>('[data-chat-composer-overlay="true"]');
    if (!container || !stack || !overlay) return;
    const measure = () => {
      const pane = overlay.getBoundingClientRect();
      const stackHeight = stack.getBoundingClientRect().height;
      setSpace({
        width: Math.max(0, Math.floor(pane.width - PANE_GUTTER * 2)),
        height: Math.max(
          0,
          Math.floor(pane.height - stackHeight - HEADLINE_SPACE - GAP_ABOVE - EDGE_MARGIN),
        ),
      });
    };
    measure();
    return observeResize([overlay, stack], measure);
  }, []);

  const grid = space === null ? null : fitWidgetGrid(space, WIDGETS_BY_PRIORITY.length);
  const visible = grid === null ? [] : WIDGETS_BY_PRIORITY.slice(0, grid.columns * grid.rows);
  // Cards grow into half of the spare height; the headline above keeps the other half.
  const gridHeight = grid === null ? 0 : grid.rows * grid.rowHeight + GRID_GAP * (grid.rows - 1);
  const rowHeight =
    grid === null || space === null
      ? 0
      : Math.max(
          grid.rowHeight,
          Math.min(
            TALL_ROW_HEIGHT,
            Math.floor(
              ((space.height - gridHeight) / 2 + gridHeight - GRID_GAP * (grid.rows - 1)) /
                grid.rows,
            ),
          ),
        );
  const roomy = rowHeight >= ROOMY_ROW_HEIGHT;
  const renderedHeight = grid === null ? 0 : grid.rows * rowHeight + GRID_GAP * (grid.rows - 1);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the grid's height to the overlay so the composer stack sits above it
  useLayoutEffect(() => {
    const overlay = containerRef.current?.closest<HTMLElement>(
      '[data-chat-composer-overlay="true"]',
    );
    if (!overlay) return;
    overlay.style.setProperty(
      "--hero-widgets-below",
      `${renderedHeight > 0 ? renderedHeight + GAP_ABOVE + EDGE_MARGIN : 0}px`,
    );
    return () => {
      overlay.style.removeProperty("--hero-widgets-below");
    };
  }, [renderedHeight]);

  return (
    <div
      ref={containerRef}
      data-hero-widgets
      className="absolute top-full left-1/2 -translate-x-1/2"
      style={space === null ? undefined : { width: space.width, marginTop: GAP_ABOVE }}
    >
      {grid === null ? null : (
        <div
          className="grid gap-2.5"
          style={{
            gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
            gridAutoRows: rowHeight,
          }}
        >
          {visible.map((widget) => (
            <div key={widget.id} className="min-h-0 [&>section]:h-full [&>section]:overflow-hidden">
              {widget.render({ now, usage, roomy })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
