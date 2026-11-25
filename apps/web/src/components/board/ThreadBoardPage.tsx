import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  SearchIcon,
  SquareKanbanIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";

import { isElectron } from "~/env";
import { openCommandPalette } from "../../commandPaletteBus";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SidebarInset } from "../ui/sidebar";
import { ThreadBoardCard } from "./ThreadBoardCard";
import { ThreadBoardPeek } from "./ThreadBoardPeek";
import { ThreadBoardUndoNotice } from "./ThreadBoardUndoNotice";
import { useBoardCards } from "./useBoardCards";
import {
  BOARD_LANES,
  buildBoardSwimlanes,
  resolveBoardArrowTarget,
  type BoardArrowKey,
  type BoardCard,
  type BoardLane,
} from "./threadBoard.logic";

const LANE_PRESENTATION: Record<BoardLane, { label: string; dotClassName: string }> = {
  needs: { label: msg("Needs you", { $context: "board lane" }), dotClassName: "bg-warning" },
  working: { label: msg("Working", { $context: "board lane" }), dotClassName: "bg-info" },
  done: { label: msg("Done", { $context: "board lane" }), dotClassName: "bg-success" },
};

/** Full-screen board of every thread, in project swimlanes crossed with state lanes. */
export function ThreadBoardPage() {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const navigateBack = useNavigateToMainApp();
  const boardCards = useBoardCards();
  const groups = useSidebarProjectGroups();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [peekKey, setPeekKey] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener: Escape closes the peek wherever focus is
  useEffect(() => {
    if (peekKey === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setPeekKey(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [peekKey]);

  const needle = query.trim().toLowerCase();
  const cards = needle
    ? boardCards.filter((card) => card.thread.title.toLowerCase().includes(needle))
    : boardCards;
  const swimlanes = buildBoardSwimlanes(groups, cards);
  // A thread that leaves the board (settled, snoozed, filtered out) closes its peek.
  const peekCard = cards.find((card) => cardKey(card) === peekKey) ?? null;
  const peekGroup =
    peekCard === null
      ? null
      : (swimlanes.find(({ lanes }) => BOARD_LANES.some((lane) => lanes[lane].includes(peekCard)))
          ?.group ?? null);

  const openThread = (card: BoardCard) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(card.thread.environmentId, card.thread.id)),
    });
  };
  // Click peeks; Ctrl-click (Cmd-click on macOS) opens the full thread.
  const onCardOpen = (card: BoardCard, event: MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey) {
      openThread(card);
      return;
    }
    setPeekKey(peekKey === cardKey(card) ? null : cardKey(card));
  };
  const onBoardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current =
      event.target instanceof HTMLElement ? event.target.dataset.boardCard : undefined;
    if (current === undefined) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      const card = cards.find((candidate) => cardKey(candidate) === current);
      if (card) {
        event.preventDefault();
        openThread(card);
      }
      return;
    }
    if (!ARROW_KEYS.has(event.key)) return;
    const grid = swimlanes
      .filter(({ group }) => !collapsed.has(group.projectKey))
      .map(({ lanes }) => BOARD_LANES.map((lane) => lanes[lane].map(cardKey)));
    const target = resolveBoardArrowTarget(grid, current, event.key as BoardArrowKey);
    if (target === null) return;
    event.preventDefault();
    event.currentTarget.querySelector<HTMLElement>(`[data-board-card="${target}"]`)?.focus();
    // With the peek open, it follows the focused card.
    if (peekKey !== null) setPeekKey(target);
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
        <div className="flex w-100 shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={gt("Back", { $context: "leave the board" })}
            onClick={() => void navigateBack()}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openCommandPalette({ open: "new-thread-in" })}
          >
            <SquarePenIcon aria-hidden />
            <T>New thread</T>
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
        <span className="flex-1" />
        <ThreadBoardUndoNotice />
      </header>

      <div className="flex min-h-0 flex-1">
        {peekCard !== null && peekGroup !== null ? (
          <ThreadBoardPeek
            key={cardKey(peekCard)}
            card={peekCard}
            project={peekGroup}
            onClose={() => setPeekKey(null)}
            onOpenThread={() => openThread(peekCard)}
          />
        ) : null}
        <div
          data-board-scroll=""
          onKeyDown={onBoardKeyDown}
          className="min-h-0 flex-1 overflow-auto px-4 pb-6 scrollbar-gutter-both"
        >
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
                              <ThreadBoardCard
                                key={card.thread.id}
                                card={card}
                                cardKey={cardKey(card)}
                                selected={peekCard === card}
                                onOpen={(event) => onCardOpen(card, event)}
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
      </div>
    </SidebarInset>
  );
}

const ARROW_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const cardKey = (card: BoardCard) => `${card.thread.environmentId}:${card.thread.id}`;
