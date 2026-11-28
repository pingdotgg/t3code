import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowUpRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useQuietThreadShells } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { Ry3Mark } from "../Ry3Mark";

const MINUTE_MS = 60_000;

/** The current time, refreshed once a minute while the new-thread screen is open. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a once-a-minute timer is an external clock the greeting and readout follow
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const RING_TICKS = [
  "top-0 left-1/2 h-1.5 w-px -translate-x-1/2",
  "bottom-0 left-1/2 h-1.5 w-px -translate-x-1/2",
  "left-0 top-1/2 h-px w-1.5 -translate-y-1/2",
  "right-0 top-1/2 h-px w-1.5 -translate-y-1/2",
] as const;

/** What the user's threads are doing right now, counted the way the sidebar reads them. */
function useThreadBriefing() {
  const threads = useQuietThreadShells();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  let working = 0;
  let needsYou = 0;
  let done = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledOverride === "settled") continue;
    const seen = {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        lastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
    };
    const status = resolveSidebarRowStatus(seen);
    if (status === "working" || status === "preparing") working += 1;
    else if (
      status === "input" ||
      status === "approval" ||
      status === "request" ||
      status === "limited" ||
      status === "failed"
    )
      needsYou += 1;
    else if (status === "ready" && hasUnseenCompletion(seen)) done += 1;
  }
  return { working, needsYou, done };
}

function BriefingPill(props: { readonly dot: string; readonly children: string }) {
  return (
    <span className="flex h-6 items-center gap-1.5 rounded-full border border-input/50 bg-muted/55 px-2.5 font-mono text-2xs text-muted-foreground uppercase tracking-wide">
      <span className={cn("size-1.5 rounded-full", props.dot)} />
      {props.children}
    </span>
  );
}

/**
 * The assistant's mark in thin flat rings (press it to talk), whether it is standing by or
 * listening, the date and time, a greeting for the hour, and what the threads are up to.
 */
export function DraftHeroGreeting() {
  const gt = useGT();
  const now = useMinuteClock();
  const { working, needsYou, done } = useThreadBriefing();
  const hour = now.getHours();
  const greeting =
    hour >= 5 && hour < 12
      ? gt("Good morning")
      : hour >= 12 && hour < 18
        ? gt("Good afternoon")
        : gt("Good evening");
  return (
    <div className="mb-5 flex flex-col items-center gap-2 [@media(max-height:34rem)]:hidden">
      <div className="group/core relative flex size-20 items-center justify-center rounded-full">
        <span className="absolute inset-0 rounded-full border border-input/40 transition-transform duration-300 ease-spring group-focus-within/composer-stack:scale-105" />
        <span className="absolute inset-2.5 rounded-full border border-input/70 transition-colors" />
        {RING_TICKS.map((position) => (
          <span key={position} className={`absolute bg-input ${position}`} />
        ))}
        <Ry3Mark className="h-8 w-auto text-foreground" eyeColor="var(--background)" />
        <span className="absolute top-1 right-1 size-2 rounded-full border border-background bg-primary transition-colors group-focus-within/composer-stack:bg-success" />
      </div>
      <p className="font-mono text-2xs text-muted-foreground uppercase tabular-nums tracking-widest">
        <span className="group-focus-within/composer-stack:hidden">{gt("Standing by")}</span>
        <span className="hidden text-foreground group-focus-within/composer-stack:inline">
          {gt("Listening")}
        </span>
        {" · "}
        {DATE_FORMAT.format(now)} · {TIME_FORMAT.format(now)}
      </p>
      <p className="text-lg text-muted-foreground">{greeting}</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {working > 0 ? (
          <BriefingPill dot="bg-info">{gt("{count} working", { count: working })}</BriefingPill>
        ) : null}
        {needsYou > 0 ? (
          <BriefingPill dot="bg-warning">
            {gt("{count} need you", { count: needsYou })}
          </BriefingPill>
        ) : null}
        {done > 0 ? (
          <BriefingPill dot="bg-success">{gt("{count} done", { count: done })}</BriefingPill>
        ) : null}
      </div>
      <DraftHeroSearch />
    </div>
  );
}

/** One-click starting points; each drops a ready-made prompt into the composer. */
export function DraftHeroSuggestions(props: {
  readonly onPick: (prompt: string) => void;
  readonly hasWorkingTreeChanges: boolean;
}) {
  const gt = useGT();
  const suggestions = [
    ...(props.hasWorkingTreeChanges
      ? [
          {
            label: gt("Commit my changes"),
            prompt: gt("Look at my uncommitted changes and write a clear commit message for them."),
          },
        ]
      : []),
    {
      label: props.hasWorkingTreeChanges ? gt("Review my changes") : gt("Review recent changes"),
      prompt: gt("Review my recent changes and point out anything risky."),
    },
    {
      label: gt("Find and fix a bug"),
      prompt: gt("Look for bugs in this project and fix the most likely one."),
    },
    {
      label: gt("Explain this project"),
      prompt: gt("Give me a quick tour of how this project is organized."),
    },
    {
      label: gt("Run the checks"),
      prompt: gt("Run the project's checks and fix whatever fails."),
    },
  ];
  return (
    <div className="mt-6 flex w-full max-w-xl flex-wrap justify-center gap-2 [@media(max-height:34rem)]:hidden">
      {suggestions.map(({ label, prompt }, index) => (
        <button
          key={label}
          type="button"
          onClick={() => props.onPick(prompt)}
          className="group/suggestion flex h-10 w-full cursor-pointer sm:w-[calc(50%-0.25rem)] items-center gap-3 rounded-lg border border-input/50 px-2.5 text-left text-muted-foreground text-sm outline-none transition-colors hover:border-input hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded border border-input/70 font-mono text-2xs text-muted-foreground tabular-nums transition-colors group-hover/suggestion:border-foreground/40 group-hover/suggestion:text-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ArrowUpRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/suggestion:opacity-100 group-focus-visible/suggestion:opacity-100"
          />
        </button>
      ))}
    </div>
  );
}

/** Opens the command palette to search threads and projects. */
function DraftHeroSearch() {
  const gt = useGT();
  return (
    <button
      type="button"
      onClick={() => openCommandPalette()}
      className="mt-1 flex h-9 w-full max-w-sm cursor-pointer items-center gap-2 rounded-lg border border-input/60 px-3 text-left text-muted-foreground text-sm outline-none transition-colors hover:border-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <SearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{gt("Search threads and projects")}</span>
    </button>
  );
}

/** The latest threads to pick back up. */
export function DraftHeroDock() {
  const gt = useGT();
  const navigate = useNavigate();
  const threads = useQuietThreadShells();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const recent = threads
    .filter((thread) => thread.archivedAt === null && thread.settledOverride !== "settled")
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 3);
  const statusDot = (thread: (typeof recent)[number]) => {
    const status = resolveSidebarRowStatus({
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        lastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
    });
    if (status === "working" || status === "preparing") return "bg-info";
    if (status === "ready") return "bg-success";
    return "bg-warning";
  };
  return (
    <div className="mt-6 flex w-full flex-col items-center gap-3 [@media(max-height:40rem)]:hidden">
      {recent.length > 0 ? (
        <div className="flex w-full max-w-2xl flex-col items-center gap-1.5">
          <p className="font-mono text-2xs text-muted-foreground uppercase tracking-widest">
            {gt("Continue where you left off")}
          </p>
          <div className="flex w-full flex-wrap justify-center gap-2">
            {recent.map((thread) => (
              <button
                key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                  })
                }
                className="flex h-8 min-w-0 max-w-56 cursor-pointer items-center gap-2 rounded-lg border border-input/50 px-2.5 text-muted-foreground text-xs outline-none transition-colors hover:border-input hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(thread))} />
                <span className="truncate">{thread.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
