import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleXIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  ShieldQuestionIcon,
  SquareKanbanIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { cn } from "../../lib/utils";
import { useDelegatedUnderParent, useQuietThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTime } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  filterSidebarV2VisibleThreads,
  useSnoozeWakeClock,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SidebarInset } from "../ui/sidebar";
import {
  BOARD_LANES,
  buildBoardSwimlanes,
  resolveBoardCard,
  type BoardCard,
  type BoardLane,
} from "./threadBoard.logic";

const LANE_PRESENTATION: Record<BoardLane, { label: string; dotClassName: string }> = {
  needs: { label: msg("Needs you", { $context: "board lane" }), dotClassName: "bg-warning" },
  working: { label: msg("Working", { $context: "board lane" }), dotClassName: "bg-info" },
  done: { label: msg("Done", { $context: "board lane" }), dotClassName: "bg-success" },
};

// Labels and colors match the sidebar's thread status (SidebarThreadRow).
const STATUS_PRESENTATION: Record<
  SidebarThreadStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  preparing: {
    label: msg("Setting up"),
    icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  working: {
    label: msg("Working", { $context: "thread status" }),
    icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  waiting: {
    label: msg("Waiting", { $context: "thread status" }),
    icon: CircleDotDashedIcon,
    className: "text-muted-foreground",
  },
  approval: {
    label: msg("Approval", { $context: "thread status: needs approval" }),
    icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
  },
  input: {
    label: msg("Input", { $context: "thread status: needs user input" }),
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: {
    label: msg("Request", { $context: "thread status: guest request" }),
    icon: UserRoundIcon,
    className: "text-guest-foreground",
  },
  limited: {
    label: msg("Limited", { $context: "thread status: usage limited" }),
    icon: CircleAlertIcon,
    className: "text-warning-foreground",
  },
  failed: {
    label: msg("Failed", { $context: "thread status" }),
    icon: CircleAlertIcon,
    className: "text-error-foreground",
  },
  ready: {
    label: msg("Done", { $context: "thread status" }),
    icon: CircleCheckIcon,
    className: "text-success-foreground",
  },
};

const CHECKS_FAILING_PRESENTATION = {
  label: msg("Checks failing", { $context: "thread status: pull request checks failing" }),
  icon: CircleXIcon,
  className: "text-error-foreground",
};

/** Full-screen board of every thread, in project swimlanes crossed with state lanes. */
export function ThreadBoardPage() {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const navigateBack = useNavigateToMainApp();
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const groups = useSidebarProjectGroups();
  const clockMs = useSnoozeWakeClock(threads);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const now = new Date(clockMs).toISOString();
  const needle = query.trim().toLowerCase();
  const cards: BoardCard[] = [];
  for (const thread of filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent)) {
    if (needle && !thread.title.toLowerCase().includes(needle)) continue;
    const card = resolveBoardCard(thread, now);
    if (card !== null) cards.push(card);
  }
  const swimlanes = buildBoardSwimlanes(groups, cards);

  const openThread = (card: BoardCard) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(card.thread.environmentId, card.thread.id)),
    });
  };
  const toggleCollapsed = (projectKey: string) => {
    const next = new Set(collapsed);
    if (!next.delete(projectKey)) next.add(projectKey);
    setCollapsed(next);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <header
        className={cn(
          "flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b pr-(--workspace-gutter-end) pl-(--workspace-controls-left)",
          isElectron && "drag-region wco:pr-(--workspace-native-controls-inset)",
        )}
      >
        <div className="flex w-[25rem] shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={gt("Back", { $context: "leave the board" })}
            onClick={() => void navigateBack()}
          >
            <ArrowLeftIcon />
          </Button>
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={gt("Search threads on the board")}
              placeholder={gt("Search threads")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
        </div>
        <h1 className="flex shrink-0 items-center gap-2 text-sm font-semibold">
          <SquareKanbanIcon aria-hidden className="size-4" />
          <T>Board</T>
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 scrollbar-gutter-both">
        {swimlanes.length === 0 ? (
          <p className="mx-auto mt-16 max-w-sm text-center text-sm text-muted-foreground">
            {needle ? (
              <T>No threads match.</T>
            ) : (
              <T>
                Nothing on the board. Threads that are running, waiting on you, or done show up
                here.
              </T>
            )}
          </p>
        ) : (
          <div className="min-w-[46rem]">
            <div className="sticky top-0 z-10 grid grid-cols-3 gap-2.5 bg-background surface-grain pt-3 pb-1.5">
              {BOARD_LANES.map((lane) => (
                <div key={lane} className="flex items-center gap-2 px-1 text-sm font-semibold">
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", LANE_PRESENTATION[lane].dotClassName)}
                  />
                  {m(LANE_PRESENTATION[lane].label)}
                  <span className="font-medium text-muted-foreground">
                    {cards.filter((card) => card.lane === lane).length}
                  </span>
                </div>
              ))}
            </div>
            {swimlanes.map(({ group, lanes }) => {
              const isCollapsed = collapsed.has(group.projectKey);
              return (
                <section key={group.projectKey} className="mt-2.5" aria-label={group.displayName}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleCollapsed(group.projectKey)}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-1.5 text-left text-sm font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <ChevronDownIcon
                      aria-hidden
                      className={cn(
                        "size-4 text-muted-foreground transition-transform",
                        isCollapsed && "-rotate-90",
                      )}
                    />
                    <ProjectFavicon project={group} className="size-4" />
                    <span className="truncate">{group.displayName}</span>
                    <span className="ml-1 flex items-center gap-2.5 text-xs font-normal text-muted-foreground">
                      {BOARD_LANES.map((lane) =>
                        lanes[lane].length === 0 ? null : (
                          <span key={lane} className="flex items-center gap-1.5">
                            <span
                              aria-hidden
                              className={cn(
                                "size-2 rounded-full",
                                LANE_PRESENTATION[lane].dotClassName,
                              )}
                            />
                            {lanes[lane].length}
                          </span>
                        ),
                      )}
                    </span>
                  </button>
                  {isCollapsed ? null : (
                    <div className="mt-1 grid grid-cols-3 gap-2.5">
                      {BOARD_LANES.map((lane) => (
                        <div
                          key={lane}
                          className={cn(
                            "flex min-h-13 flex-col gap-1.5 rounded-xl border p-1.5",
                            lanes[lane].length === 0 ? "border-dashed" : "bg-muted/60",
                          )}
                        >
                          {lanes[lane].map((card) => (
                            <BoardCardButton
                              key={card.thread.id}
                              card={card}
                              onOpen={() => openThread(card)}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function BoardCardButton(props: { card: BoardCard; onOpen: () => void }) {
  const m = useMessages();
  const { card } = props;
  const status =
    card.lane === "needs" && card.status === "ready"
      ? CHECKS_FAILING_PRESENTATION
      : STATUS_PRESENTATION[card.status];
  const StatusIcon = status.icon;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-left shadow-xs/5 outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn("flex min-w-0 items-center gap-1.5 text-xs font-medium", status.className)}
        >
          <StatusIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{m(status.label)}</span>
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          <BoardRelativeTime timestamp={card.activityAt} />
        </span>
      </span>
      <span className="line-clamp-2 text-sm font-medium leading-snug">{card.thread.title}</span>
    </button>
  );
}

// Subscribes to the minute tick itself, so only the label re-renders each minute.
function BoardRelativeTime(props: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const m = useMessages();
  const parts = formatRelativeTime(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), m);
  if (parts === null) return null;
  return parts.suffix === null ? m(msg("now", { $context: "relative time" })) : parts.value;
}
