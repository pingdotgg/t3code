import { answerSummary, VERDICT_BUTTONS, optionMedia } from "@cz/client-runtime/decisions/draft";
import {
  buildOneFeed,
  type FeedProjectGroup,
  feedFolderLabel,
  feedProjectGroup,
  feedProjectKey,
  shortMachineLabel,
} from "@cz/client-runtime/decisions/oneFeed";
import type { EnvironmentThreadShell } from "@cz/client-runtime/state/models";
import type { DecisionAnswerInput, DecisionMediaRef } from "@cz/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { CheckIcon, InboxIcon, PencilIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useFeedFilterStore } from "~/feedFilterStore";
import { cn } from "~/lib/utils";
import {
  type DecisionEntry,
  type DecisionFeed,
  decisionEnvironment,
  useAnsweredDecisions,
  useFilteredOpenDecisions,
  useOpenDecisions,
  useProjectBlurbs,
  useThreadDigests,
} from "~/state/decisions";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useJobsOn } from "~/state/jobs";
import { useNavigateBack } from "~/hooks/useNavigateBack";
import { useVimKeys } from "~/hooks/useVimKeys";
import { useAtomCommand } from "~/state/use-atom-command";
import { DECISION_OPTION_FRAME_CLASS, DecisionMedia } from "../decisions/DecisionMedia";
import { DecisionView, type UploadDecisionMedia } from "../decisions/DecisionView";
import { NoProjectsHero } from "../NoProjectsHero";
import { SidebarUpdateArchitectureWarning } from "../sidebar/SidebarUpdatePill";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { FeedModal } from "./FeedModal";
import { FeedThreadCard } from "./FeedThreadCard";
import { FeedGroupToggle, type FeedProjectChoice, FeedProjectsMenu } from "./FeedFilters";
import { FeedThreadGroups, ThreadsViewControls } from "./FeedThreadGroups";
import { FeedTopBar } from "./FeedTopBar";
import { MorningBriefCard } from "./MorningBriefCard";

/**
 * Moves focus through the feed's cards, rows and groups: by `step` items, to
 * an end, or by half a screen ("half"), keeping the focused item in view.
 */
function focusFeedItem(step: number | "first" | "last" | "half-down" | "half-up") {
  const items = [
    ...document.querySelectorAll<HTMLElement>("[data-feed-page] [data-feed-item]"),
  ].filter((item) => item.offsetParent !== null);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (step === "first") next = items[0];
  else if (step === "last") next = items.at(-1);
  else if (step === "half-down" || step === "half-up") {
    const from = items[current]?.getBoundingClientRect().top ?? 0;
    const offset = (step === "half-down" ? 1 : -1) * (window.innerHeight / 2);
    const goal = from + offset;
    next =
      step === "half-down"
        ? (items.find((item) => item.getBoundingClientRect().top >= goal) ?? items.at(-1))
        : (items.findLast((item) => item.getBoundingClientRect().top <= goal) ?? items[0]);
  } else
    next =
      current === -1
        ? items[step > 0 ? 0 : items.length - 1]
        : items[Math.min(items.length - 1, Math.max(0, current + step))];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

/** How long an answer can be undone before it is sent. */
const UNDO_WINDOW_MS = 5_000;

const entryKey = (entry: Pick<DecisionEntry, "environmentId" | "item">) =>
  `${entry.environmentId}:${entry.item.id}`;

interface PendingAnswer {
  readonly entry: DecisionEntry;
  /** null: "Dismiss", which withdraws the Decision. */
  readonly answer: DecisionAnswerInput | null;
  readonly timer: ReturnType<typeof setTimeout>;
}

function ageLabel(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** How many threads' digests (summary line, folder) the feed reads: the most recent ones. */
const DIGEST_LIMIT = 200;

/**
 * The one feed (layout A): a slim top bar, then one column. Threads and
 * decisions merge: a thread's decisions ride on its card, decisions from
 * outside a thread get their own card, and cards that need the owner come
 * first. Finished and running threads follow as compact rows. Everything
 * else (a thread, settings, a decision) opens in a modal over it.
 */
export function FeedPage() {
  const navigate = useNavigate();
  const feed = useOpenDecisions();
  const filtered = useFilteredOpenDecisions();
  const answered = useAnsweredDecisions();
  const blurbs = useProjectBlurbs();
  const threads = useThreadShells();
  const projects = useProjects();
  const { presentationById } = useEnvironments();
  const answerCommand = useAtomCommand(decisionEnvironment.answer, "answer decision");
  const uploadCommand = useAtomCommand(decisionEnvironment.upload, "upload decision media");
  const withdrawCommand = useAtomCommand(decisionEnvironment.withdraw, "dismiss decision");
  const selectedProjects = useFeedFilterStore((state) => state.projects);
  const group = useFeedFilterStore((state) => state.group);
  const threadsView = useFeedFilterStore((state) => state.threadsView);
  const [showAnswered, setShowAnswered] = useState(false);
  const location = useLocation({
    select: (value) => ({ pathname: value.pathname, search: value.search }),
  });
  // The open Decision lives in the URL (/decisions?open=…), so Back closes it.
  const onDecisions = location.pathname === "/decisions";
  const openKey =
    onDecisions && typeof location.search.open === "string" ? location.search.open : null;
  const navigateBack = useNavigateBack();
  /** Opens a Decision; stepping from one to the next replaces the entry, so Back leaves them all. */
  const showDecision = (key: string | null) => {
    if (key === null) {
      navigateBack();
      return;
    }
    void navigate({
      to: "/decisions",
      search: { open: key },
      replace: openKey !== null,
    });
  };
  const [pending, setPending] = useState<ReadonlyMap<string, PendingAnswer>>(new Map());
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const machineLabel = (environmentId: string) =>
    presentationById.get(environmentId as never)?.entry.target.label ?? "";
  const projectById = useMemo(
    () =>
      new Map(
        projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
      ),
    [projects],
  );

  // What this machine filter and device could show, whatever projects are
  // picked: the project menu offers these, and the Morning brief reads them.
  const reachable = useMemo(
    () =>
      buildOneFeed({
        threads: [],
        decisions: feed.entries,
        filter: {
          machine: filtered.filter.machine,
          ...(filtered.filter.device ? { device: filtered.filter.device } : {}),
        },
      }).flatMap((card) => (card.kind === "decision" ? [card.decision] : [])),
    [feed.entries, filtered.filter.machine, filtered.filter.device],
  );
  const machine = filtered.filter.machine;
  // Every listed thread, with the folder it works in: its project and group.
  const listedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.lineage.relationshipToParent !== "subagent" &&
          (machine.type === "all" || thread.environmentId === machine.environmentId),
      ),
    [threads, machine],
  );
  const digests = useThreadDigests(
    useMemo(
      () =>
        [...listedThreads]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, DIGEST_LIMIT),
      [listedThreads],
    ),
  );
  const folderOf = useCallback(
    (thread: EnvironmentThreadShell) =>
      feedFolderLabel(
        projectById.get(`${thread.environmentId}:${thread.projectId}`)?.title ?? "",
        digests.get(`${thread.environmentId}:${thread.id}`)?.workingSubpath,
      ),
    [projectById, digests],
  );
  const threadGroupOf = useCallback(
    (thread: EnvironmentThreadShell) =>
      feedProjectGroup(
        `${projectById.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ?? ""}/${folderOf(thread)}`,
      ),
    [projectById, folderOf],
  );
  const groupOf = useMemo(() => {
    const fromThreads = new Map(
      listedThreads.map((thread) => [feedProjectKey(folderOf(thread)), threadGroupOf(thread)]),
    );
    return (project: string): FeedProjectGroup =>
      blurbs.get(project)?.group ?? fromThreads.get(project) ?? "software";
  }, [listedThreads, folderOf, threadGroupOf, blurbs]);
  const projectChoices = useMemo((): FeedProjectChoice[] => {
    const names = new Set([
      ...reachable.map((entry) => entry.item.project),
      ...listedThreads.map((thread) => feedProjectKey(folderOf(thread))),
    ]);
    return [...names]
      .filter((name) => name !== "")
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        group: groupOf(name),
        description: blurbs.get(name)?.description ?? null,
      }));
  }, [reachable, listedThreads, folderOf, groupOf, blurbs]);

  const shownMachineIds = useMemo(
    () => (machine.type === "all" ? [...presentationById.keys()] : [machine.environmentId]),
    [machine, presentationById],
  );
  const jobs = useJobsOn(shownMachineIds);
  const shownThreads = useMemo(
    () =>
      threads.filter(
        (thread) => machine.type === "all" || thread.environmentId === machine.environmentId,
      ),
    [threads, machine],
  );

  // Answered items stay hidden until the next refresh drops them from the feed.
  const cards = useMemo(
    () =>
      buildOneFeed({
        threads,
        decisions: feed.entries.filter(
          (entry) => !pending.has(entryKey(entry)) && !sent.has(entryKey(entry)),
        ),
        filter: {
          ...filtered.filter,
          ...(group ? { groupOf } : {}),
          threadProject: (thread) => feedProjectKey(folderOf(thread as EnvironmentThreadShell)),
        },
      }),
    [threads, feed.entries, filtered.filter, pending, sent, group, groupOf, folderOf],
  );
  const needsYou = cards.filter((card) => card.needsYou);
  const waitingThreads = useMemo(
    () =>
      new Set(
        needsYou.flatMap((card) =>
          card.kind === "thread" ? [`${card.thread.environmentId}:${card.thread.id}`] : [],
        ),
      ),
    [needsYou],
  );
  // The Threads tab: every listed thread under the picked projects and group.
  const groupedThreads = listedThreads.filter((thread) => {
    const project = feedProjectKey(folderOf(thread));
    return (
      (selectedProjects.length === 0 || selectedProjects.includes(project)) &&
      (group === null || threadGroupOf(thread) === group)
    );
  });
  // Needs you (/) and Threads (/threads) are two pages; a Decision opens over Needs you.
  const tab: "needs" | "threads" = location.pathname === "/threads" ? "threads" : "needs";
  const openProject =
    tab === "threads" && typeof location.search.project === "string"
      ? location.search.project
      : null;
  // The project grid needs room; every other view reads as one column.
  const wide = tab === "threads" && openProject === null && threadsView === "grid";
  // Each page keeps its own scroll position across switches.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollTops = useRef({ needs: 0, threads: 0 });
  const shownTab = useRef(tab);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || shownTab.current === tab) return;
    scrollTops.current[shownTab.current] = scroller.scrollTop;
    shownTab.current = tab;
    scroller.scrollTop = scrollTops.current[tab];
  }, [tab]);
  const answeredShown = answered.entries.filter(
    (entry) =>
      (machine.type === "all" || entry.environmentId === machine.environmentId) &&
      (selectedProjects.length === 0 || selectedProjects.includes(entry.item.project)) &&
      (group === null || groupOf(entry.item.project) === group),
  );

  // Decisions in feed order, for Review all and the modal's position.
  const visible = useMemo(
    () => cards.flatMap((card) => (card.kind === "decision" ? [card.decision] : card.decisions)),
    [cards],
  );

  const send = useCallback(
    async (key: string) => {
      const item = pendingRef.current.get(key);
      if (!item) return;
      setPending((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      const result =
        item.answer === null
          ? await withdrawCommand({
              environmentId: item.entry.environmentId,
              input: { id: item.entry.item.id },
            })
          : await answerCommand({
              environmentId: item.entry.environmentId,
              input: { id: item.entry.item.id, answer: item.answer },
            });
      if (result._tag === "Success") setSent((current) => new Set(current).add(key));
    },
    [answerCommand, withdrawCommand],
  );

  useEffect(
    () => () => {
      for (const item of pendingRef.current.values()) clearTimeout(item.timer);
    },
    [],
  );

  const undo = (key: string) => {
    const item = pendingRef.current.get(key);
    if (!item) return;
    clearTimeout(item.timer);
    setPending((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  };

  const closeDecision = () => showDecision(null);

  /** Answers, or with null dismisses as no longer relevant, after an undo window. */
  const answer = (entry: DecisionEntry, value: DecisionAnswerInput | null) => {
    const key = entryKey(entry);
    const timer = setTimeout(() => void send(key), UNDO_WINDOW_MS);
    setPending((current) => new Map(current).set(key, { entry, answer: value, timer }));
    toastManager.add({
      type: "success",
      title: entry.item.title || entry.item.question,
      description:
        value === null ? "Dismissed: no longer relevant" : answerSummary(entry.item, value),
      timeout: UNDO_WINDOW_MS,
      actionProps: { children: "Undo", onClick: () => undo(key) },
    });
    // In the full view, answering moves on to the next open Decision, then back to the list.
    if (openKey === null) return;
    const index = visible.findIndex((candidate) => entryKey(candidate) === key);
    const rest = visible.filter((candidate) => entryKey(candidate) !== key);
    const next = rest[index] ?? rest[index - 1];
    showDecision(next ? entryKey(next) : null);
  };
  const quickAnswer = (entry: DecisionEntry, patch: Partial<DecisionAnswerInput>) =>
    answer(entry, {
      choice: null,
      option_ids: null,
      rank: null,
      comment: null,
      voice_key: null,
      ...patch,
    });

  const opened = openKey === null ? null : visible.find((entry) => entryKey(entry) === openKey);
  const upload: UploadDecisionMedia | null = opened
    ? async (meta, bytes) => {
        const result = await uploadCommand({
          environmentId: opened.environmentId,
          input: { meta, bytes },
        });
        return result._tag === "Success" ? (result.value as DecisionMediaRef) : null;
      }
    : null;
  // Lines for one or two picked projects; a whole group would be a wall of text.
  const selectedBlurbs = (selectedProjects.length <= 2 ? selectedProjects : []).map((project) => ({
    project,
    description: blurbs.get(project)?.description ?? null,
  }));

  const threadPlacement = (thread: EnvironmentThreadShell) => {
    const project = projectById.get(`${thread.environmentId}:${thread.projectId}`);
    const digest = digests.get(`${thread.environmentId}:${thread.id}`);
    const folder = feedFolderLabel(project?.title ?? "", digest?.workingSubpath);
    return {
      machine: machineLabel(thread.environmentId),
      folder,
      project: feedProjectKey(folder),
      excerpt: digest?.excerpt ?? null,
      age: ageLabel(Date.parse(thread.updatedAt), now),
    };
  };
  const decisionCard = (entry: DecisionEntry, embedded = false) => (
    <DecisionCard
      key={entryKey(entry)}
      entry={entry}
      embedded={embedded}
      age={ageLabel(entry.item.created_at, now)}
      showMachine={machine.type === "all"}
      onOpen={() => showDecision(entryKey(entry))}
      onQuickAnswer={(patch) => quickAnswer(entry, patch)}
      onDismiss={() => answer(entry, null)}
    />
  );

  // ccez-llm motions over cards, rows and groups: j/k one, d/u three, Ctrl+D/U
  // half a screen, gg/G the ends; l or Enter opens the focused one.
  useVimKeys(
    {
      move: (direction, size) =>
        focusFeedItem(
          size === "half"
            ? direction > 0
              ? "half-down"
              : "half-up"
            : direction * (size === "skip" ? 3 : 1),
        ),
      top: () => focusFeedItem("first"),
      bottom: () => focusFeedItem("last"),
      open: () => {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.closest("[data-feed-page] [data-feed-item]"))
          focused.click();
      },
    },
    (location.pathname === "/" ||
      location.pathname === "/threads" ||
      location.pathname === "/decisions") &&
      openKey === null,
  );

  const filters = (
    <>
      <FeedGroupToggle />
      <FeedProjectsMenu projects={projectChoices} />
    </>
  );

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background" data-feed-page="">
      <FeedTopBar
        badge={filtered.entries.length}
        reviewing={visible.length > 0}
        onReviewAll={() => {
          if (visible[0]) showDecision(entryKey(visible[0]));
        }}
        filters={filters}
      />
      {/* The page never scrolls sideways; only the chip row does. A long URL or word wraps. */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div
          className={cn(
            "mx-auto w-full min-w-0 space-y-3 px-4 py-4 wrap-anywhere",
            wide ? "max-w-7xl" : "max-w-2xl",
          )}
        >
          <SidebarUpdateArchitectureWarning />
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              aria-label="Feed"
              value={[tab]}
              onValueChange={(value) => {
                const next = value[0];
                if ((next === "needs" || next === "threads") && next !== tab) {
                  void navigate({ to: next === "threads" ? "/threads" : "/" });
                }
              }}
            >
              <Toggle size="sm" value="needs">
                Needs you
                <span className="tabular-nums text-warning-foreground">{needsYou.length}</span>
              </Toggle>
              <Toggle size="sm" value="threads">
                Threads
                <span className="tabular-nums text-muted-foreground">{groupedThreads.length}</span>
              </Toggle>
            </ToggleGroup>
            {tab === "threads" && openProject === null ? (
              <ThreadsViewControls
                projects={[
                  ...new Set(groupedThreads.map((thread) => feedProjectKey(folderOf(thread)))),
                ]}
              />
            ) : null}
          </div>
          {/* Beside the search bar on wider screens; here on a phone. */}
          <div className="flex flex-wrap items-center gap-1.5 md:hidden">{filters}</div>
          {selectedBlurbs.map(({ project, description }) => (
            <ProjectBlurbLine key={project} project={project} description={description} />
          ))}
          {tab === "needs" ? (
            <MorningBriefCard
              environmentIds={shownMachineIds}
              decisions={reachable}
              threads={shownThreads}
              jobs={jobs}
              now={now}
              machineLabel={machineLabel}
              onOpenDecision={showDecision}
            />
          ) : null}

          {tab === "threads" ? (
            groupedThreads.length === 0 ? (
              projects.length === 0 ? (
                <NoProjectsHero />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">No threads here.</p>
              )
            ) : (
              <FeedThreadGroups
                threads={groupedThreads}
                place={threadPlacement}
                needsYou={(thread) =>
                  waitingThreads.has(`${thread.environmentId}:${thread.id}`) ||
                  thread.hasPendingApprovals ||
                  thread.hasPendingUserInput
                }
                project={openProject}
                now={now}
                enabled={openKey === null}
              />
            )
          ) : feed.isPending && threads.length === 0 ? (
            <>
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </>
          ) : (
            <>
              {needsYou.length === 0 && pending.size === 0 ? (
                projects.length === 0 ? (
                  <NoProjectsHero />
                ) : (
                  <Empty className="min-h-48">
                    <EmptyMedia variant="icon">
                      <InboxIcon />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>Nothing needs you</EmptyTitle>
                    </EmptyHeader>
                    <Button size="sm" variant="outline" render={<Link to="/threads" />}>
                      See threads
                    </Button>
                  </Empty>
                )
              ) : null}
              {needsYou.map((card) => {
                if (card.kind === "decision") return decisionCard(card.decision);
                const placement = threadPlacement(card.thread);
                return (
                  <FeedThreadCard
                    key={card.key}
                    thread={card.thread}
                    {...placement}
                    status="needs-you"
                  >
                    {card.decisions.length > 0
                      ? card.decisions.map((entry) => decisionCard(entry, true))
                      : null}
                  </FeedThreadCard>
                );
              })}
              <Button
                size="xs"
                variant="ghost-muted"
                className="self-start"
                onClick={() => setShowAnswered((shown) => !shown)}
              >
                {showAnswered ? "Hide answered" : `Answered (${answeredShown.length})`}
              </Button>
              {showAnswered ? (
                <AnsweredList feed={{ ...answered, entries: answeredShown }} now={now} />
              ) : null}
            </>
          )}

          {feed.unreachable.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Couldn't reach {feed.unreachable.join(", ")}; their decisions show up when they're
              back.
            </p>
          ) : null}
        </div>
      </div>
      {opened && upload ? (
        <FeedModal label={opened.item.title || opened.item.question} onClose={closeDecision}>
          <DecisionView
            key={openKey}
            entry={opened}
            {...(visible.length > 1
              ? {
                  position: { index: visible.indexOf(opened), total: visible.length },
                  onSkip: () => {
                    const index = visible.indexOf(opened);
                    const next = visible[index + 1] ?? visible[0];
                    if (next) showDecision(entryKey(next));
                  },
                  onPrevious: () => {
                    const index = visible.indexOf(opened);
                    const previous = visible[index - 1] ?? visible.at(-1);
                    if (previous) showDecision(entryKey(previous));
                  },
                }
              : {})}
            onSubmit={(value) => answer(opened, value)}
            onDismiss={() => answer(opened, null)}
            onUpload={upload}
            onClose={closeDecision}
          />
        </FeedModal>
      ) : null}
    </div>
  );
}

/** "courtroom: trial adventure…" under the tabs for a picked project, with the owner's own line editable. */
function ProjectBlurbLine({
  project,
  description,
}: {
  readonly project: string;
  readonly description: string | null;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const describe = useAtomCommand(decisionEnvironment.describeProject, "describe project");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description ?? "");
  const save = async () => {
    setEditing(false);
    if (environmentId === null || draft.trim() === (description ?? "")) return;
    await describe({ environmentId, input: { project, description: draft.trim() || null } });
  };
  return editing ? (
    <Input
      autoFocus
      size="sm"
      aria-label={`What ${project} is`}
      value={draft}
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") void save();
        if (event.key === "Escape") setEditing(false);
      }}
    />
  ) : (
    <p className="group flex items-start gap-1.5 text-sm text-muted-foreground">
      <span>
        <span className="font-medium text-foreground">{project}</span>
        {description ? `: ${description}` : ": no description yet"}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Edit what ${project} is`}
        onClick={() => {
          setDraft(description ?? "");
          setEditing(true);
        }}
      >
        <PencilIcon />
      </Button>
    </p>
  );
}

/** Answered decisions: what was asked, the choice with its pictures, and the note. */
function AnsweredList({ feed, now }: { readonly feed: DecisionFeed; readonly now: number }) {
  if (feed.isPending) return <Skeleton className="h-28 w-full" />;
  if (feed.entries.length === 0) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyTitle>No answers yet</EmptyTitle>
          <EmptyDescription>Decisions you answer show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return feed.entries.map((entry) => {
    const { item, answer } = entry;
    const chosen = item.options.filter((option) => answer?.option_ids?.includes(option.id));
    const pictures = chosen.flatMap((option) => {
      const media = optionMedia(item, option);
      return media?.type === "image" ? [media] : [];
    });
    return (
      <article
        key={entryKey(entry)}
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        data-decision-answered={item.kind}
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="secondary" size="sm">
            {item.kind}
          </Badge>
          <span className="truncate">
            {item.project} · {entry.environmentLabel}
          </span>
          <span className="ml-auto shrink-0">
            {item.answered_at ? ageLabel(item.answered_at, now) : null}
          </span>
        </div>
        <h2 className="font-medium text-foreground">{item.title || item.question}</h2>
        {pictures.length > 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {pictures.map((media, index) => (
              <DecisionMedia
                key={`${media.key}:${index}`}
                environmentId={entry.environmentId}
                media={media}
                framed
              />
            ))}
          </div>
        ) : null}
        {answer ? (
          <p className="text-sm text-foreground">
            <CheckIcon className="me-1 inline size-3.5 text-success-foreground" />
            {answerSummary(item, answer)}
          </p>
        ) : null}
        {answer?.comment ? (
          <p className="text-sm text-muted-foreground">“{answer.comment}”</p>
        ) : null}
        {item.thread ? (
          <Button
            size="xs"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: entry.environmentId, threadId: item.thread }}
              />
            }
          >
            Open thread
          </Button>
        ) : null}
      </article>
    );
  });
}

/**
 * A decision as a feed card that reads in three seconds: the thing itself
 * (a clip, a waveform, pictures), one line of question, then the answer.
 * Most never need opening: a single-choice pick answers from its options,
 * review and pitch from their verdicts, a playtest installs from the card.
 * Project and age trail in small type. `embedded` drops the frame for a
 * decision riding on its thread's card.
 */
function DecisionCard({
  entry,
  age,
  showMachine,
  embedded = false,
  onOpen,
  onQuickAnswer,
  onDismiss,
}: {
  entry: DecisionEntry;
  age: string;
  /** Name the machine only when the feed shows more than one. */
  showMachine: boolean;
  embedded?: boolean;
  onOpen: () => void;
  onQuickAnswer: (patch: Partial<DecisionAnswerInput>) => void;
  /** Dismisses it: withdraws it as no longer relevant. */
  onDismiss: () => void;
}) {
  const { item } = entry;
  const optionsCarryMedia = item.kind === "pick" || item.kind === "rank";
  // A sound or a video plays right on the card, the thing itself before any text.
  const preview = optionsCarryMedia
    ? undefined
    : item.media.find((media) => media.type === "audio" || media.type === "video");
  // Otherwise up to three pictures, enough to judge whether it needs a closer look.
  const pictures =
    optionsCarryMedia || preview
      ? []
      : item.media.filter((media) => media.type === "image").slice(0, 3);
  // A review or pitch answers right on the card; a wrong answer is undone from its toast.
  const quick = item.kind === "review" || item.kind === "pitch" ? VERDICT_BUTTONS[item.kind] : null;
  const mediaOf = (option: (typeof item.options)[number]) => optionMedia(item, option);
  // Only single-choice picks answer from the card; the rest open the full view.
  const inlinePick = item.kind === "pick" && item.max_choices === 1 && item.options.length > 0;
  const optionPictures =
    inlinePick && item.options.some((option) => mediaOf(option)?.type === "image");
  const apk =
    item.kind === "playtest" ? item.media.find((media) => media.type === "apk") : undefined;
  const title = embedded ? item.question : item.title || item.question;
  const subtitle = !embedded && item.title && item.title !== item.question ? item.question : null;
  return (
    <article
      className={cn(
        "space-y-3",
        embedded
          ? "border-t border-border pt-3"
          : "rounded-lg border border-warning/40 bg-card p-4",
      )}
      data-decision-card={item.kind}
    >
      {preview ? (
        <DecisionMedia
          environmentId={entry.environmentId}
          media={preview}
          compact={preview.type === "audio"}
          {...(preview.type === "video" ? { className: "max-h-72" } : {})}
        />
      ) : null}
      {pictures.length > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={cn("grid w-full gap-2", pictures.length > 1 ? "grid-cols-3" : "grid-cols-1")}
          onClick={onOpen}
        >
          {pictures.map((media) => (
            <DecisionMedia
              key={media.key}
              environmentId={entry.environmentId}
              media={media}
              framed
              {...(pictures.length === 1 ? { className: "aspect-[16/9]" } : {})}
            />
          ))}
        </button>
      ) : null}
      <button
        type="button"
        data-feed-item=""
        className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        <h3
          className={cn(
            "line-clamp-2 text-foreground",
            embedded ? "text-sm font-medium" : "font-medium",
          )}
        >
          {title}
        </h3>
        {subtitle ? <p className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</p> : null}
        {item.cost_note ? (
          <p className="text-xs text-warning-foreground">{item.cost_note}</p>
        ) : null}
      </button>
      {inlinePick ? (
        optionPictures ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {item.options.map((option) => {
              const media = mediaOf(option);
              return (
                <button
                  key={option.id}
                  type="button"
                  className="space-y-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onQuickAnswer({ option_ids: [option.id] })}
                  aria-label={`Pick ${option.label}`}
                >
                  {media ? (
                    <DecisionMedia environmentId={entry.environmentId} media={media} framed />
                  ) : (
                    <span
                      className={cn(
                        DECISION_OPTION_FRAME_CLASS,
                        "flex items-center justify-center p-2 text-center text-sm",
                      )}
                    >
                      {option.label}
                    </span>
                  )}
                  {media ? (
                    <span className="line-clamp-2 text-xs text-foreground">
                      {option.label}
                      {option.recommended ? " ★" : ""}
                    </span>
                  ) : option.recommended ? (
                    <span className="text-xs text-foreground">★ recommended</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          // Long labels wrap instead of running off a phone screen.
          <div className="grid gap-1.5">
            {item.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="rounded-md border border-border px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onQuickAnswer({ option_ids: [option.id] })}
              >
                {option.label}
                {option.recommended ? " ★" : ""}
              </button>
            ))}
          </div>
        )
      ) : null}
      {quick || apk ? (
        <div className="flex flex-wrap gap-2">
          {apk ? <DecisionMedia environmentId={entry.environmentId} media={apk} /> : null}
          {quick?.map((button) => (
            <Button
              key={button.value}
              size="sm"
              variant={button.value === "approve" || button.value === "yes" ? "default" : "outline"}
              onClick={() =>
                button.value === "changes" ? onOpen() : onQuickAnswer({ choice: button.value })
              }
            >
              {button.label}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-y-1">
        {inlinePick || quick ? null : (
          <Button size="sm" variant="outline" onClick={onOpen}>
            Open
          </Button>
        )}
        {item.kind === "pick" ? (
          <Button
            size="xs"
            variant="ghost-muted"
            title="Asks for new options"
            onClick={() => onQuickAnswer({ retry: true })}
          >
            None of these
          </Button>
        ) : null}
        <Button size="xs" variant="ghost-muted" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {embedded ? null : (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {item.blocking ? (
            <Badge variant="warning" size="sm">
              Agent waiting
            </Badge>
          ) : null}
          <span className="truncate">
            {showMachine ? `${shortMachineLabel(entry.environmentLabel)} · ` : ""}
            {item.project}
          </span>
          <span className="ms-auto shrink-0">{age}</span>
        </div>
      )}
    </article>
  );
}
