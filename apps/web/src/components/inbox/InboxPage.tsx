/**
 * The report inbox. Sections the reader defined come first, then the built-in
 * ones; every report lands in exactly one. Rows carry no rules between them —
 * whitespace and hover do the separating, so a long queue reads as a list of
 * reports rather than a table of cells.
 *
 * Triage is a focus state of this page rather than a route: `t` swaps the list
 * for one report at a time, `esc` brings the list back, and the queue survives
 * a trip into a conversation and back.
 */
import type { EnvironmentId, PostHogInboxFilter, PostHogReport } from "@t3tools/contracts";
import { PostHogReportId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  EllipsisIcon,
  ListChecksIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../../brand/EmptyState";
import { isElectron } from "../../env";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { selectReportSeenMap, useReportSeenStore } from "../../reportSeenStore";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { postHogEnvironment, reportsListAtom } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerSettingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { IMPLEMENT_INTENT } from "../reports/reportIntent";
import type { ReportDecisionHandlers } from "../reports/ReportDecision";
import { usePostHogQuery, type PostHogQueryError } from "../reports/reportsQuery";
import { ReportArtefactWarmup, usePostHogViewerLogin, useSettled } from "../reports/reportWarmup";
import { useReportOpener } from "../reports/useOpenReport";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isReportUnread, nextFocusedReportId } from "./inboxList.logic";
import {
  buildDoneSections,
  buildInboxSections,
  buildReportWork,
  nextCustomSectionId,
  NO_WORK,
  SECTION_PAGE_SIZE,
  visibleSectionReports,
  type InboxScope,
  type InboxSectionGroup,
} from "./inboxSections.logic";
import { ReportRow } from "./ReportRow";
import { SectionEditorDialog } from "./SectionEditorDialog";
import { TriageFocus, type TriagePassControls } from "./TriageFocus";
import { useTriageStore } from "./triageStore";

export type InboxView = "inbox" | "done";

const VIEW_TITLES: Readonly<Record<InboxView, string>> = {
  inbox: "Inbox",
  done: "Done",
};

const SCOPE_OPTIONS = [
  { value: "for-you", label: "For you", hint: "Reports PostHog named you a reviewer on" },
  { value: "everyone", label: "Everyone", hint: "Every report in the project" },
] as const satisfies ReadonlyArray<{
  readonly value: InboxScope;
  readonly label: string;
  readonly hint: string;
}>;

/** Sections whose reports are asking for something, in the order they read. */
const DECISION_SECTION_IDS: ReadonlySet<string> = new Set(["needs-you"]);

/** How much of the decision queue is in hand before `t` is pressed. */
const TRIAGE_WARM_HEAD = 3;

function PostHogErrorState({ error }: { readonly error: PostHogQueryError }) {
  const navigate = useNavigate();
  const state =
    error.tag === "not-configured"
      ? {
          hoggie: "notConfigured" as const,
          title: "Connect PostHog",
          body: "Add your PostHog host, project, and personal API key in settings.",
        }
      : error.tag === "unauthorized"
        ? {
            hoggie: "notConfigured" as const,
            title: "PostHog rejected the API key",
            body: "Check the personal API key in settings. It may have expired or lost its scope.",
          }
        : {
            hoggie: "requestFailed" as const,
            title: "PostHog request failed",
            body: error.message,
          };

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <EmptyState
        hoggie={state.hoggie}
        title={state.title}
        body={state.body}
        action={
          <Button size="sm" onClick={() => void navigate({ to: "/settings/integrations" })}>
            Open PostHog settings
          </Button>
        }
      />
    </div>
  );
}

function SectionHeading({
  group,
  collapsed,
  onToggle,
  onEdit,
}: {
  readonly group: InboxSectionGroup;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onEdit: (() => void) | null;
}) {
  return (
    // Sticky: a long run down the list should never leave you unsure which
    // queue you are in.
    <div className="group/section sticky top-0 z-10 flex items-baseline gap-2 bg-background px-3 pt-2 pb-1.5">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex items-baseline gap-2 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 self-center text-muted-foreground/60 transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        {/* Weight and color rather than small caps: these labels are written
            as sentences, and "PostHog is still investigating" shouted is
            harder to read, not more structural. */}
        <h2 className="text-xs font-semibold text-foreground/70">{group.label}</h2>
        <span className="text-xs tabular-nums text-muted-foreground/60">
          {group.reports.length}
        </span>
      </button>
      {onEdit ? (
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Edit ${group.label}`}
          className="opacity-0 transition-opacity group-hover/section:opacity-100"
          onClick={onEdit}
        >
          <PencilIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Warms the focused report's artefacts so opening it paints rather than waits.
 * Trails the focus by a beat: holding j to run down the list should not fire a
 * request per row it passes through.
 */
function usePrefetchFocusedReport(
  environmentId: EnvironmentId,
  focusedReportId: string | null,
): void {
  const [settledReportId, setSettledReportId] = useState<string | null>(null);
  useEffect(() => {
    if (focusedReportId === null) return;
    const timer = setTimeout(() => setSettledReportId(focusedReportId), 250);
    return () => clearTimeout(timer);
  }, [focusedReportId]);

  useEnvironmentQuery(
    settledReportId === null
      ? null
      : postHogEnvironment.artefacts({
          environmentId,
          input: { reportId: PostHogReportId.make(settledReportId) },
        }),
  );
}

export function InboxPage({ view }: { readonly view: InboxView }) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
          <h1 className="text-sm font-semibold">{VIEW_TITLES[view]}</h1>
        </WorkspacePageHeader>
        <p className="p-5 text-sm text-muted-foreground">Connect a server to see reports.</p>
      </SidebarInset>
    );
  }
  return <ConnectedInboxPage environmentId={environmentId} view={view} />;
}

function ConnectedInboxPage({
  environmentId,
  view,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: InboxView;
}) {
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const refreshReports = reportsQuery.refresh;
  const seen = useReportSeenStore(selectReportSeenMap);
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const updateSettings = useUpdatePrimarySettings();
  const customSections = serverSettings.posthog.inboxSections;
  const showNotActionable = serverSettings.posthog.showNotActionableReports;

  const setReportState = useAtomCommand(postHogEnvironment.setReportState, {
    reportFailure: false,
  });
  const setReviewers = useAtomCommand(postHogEnvironment.setReviewers, { reportFailure: false });
  const { openReport, error: openError, dismissError } = useReportOpener(environmentId);
  const navigate = useNavigate();

  const triageActive = useTriageStore((state) => state.active);
  const beginTriage = useTriageStore((state) => state.begin);
  const endTriage = useTriageStore((state) => state.end);
  const [scope, setScope] = useState<InboxScope>("for-you");

  // The half of a report's state PostHog cannot see: conversations, worktrees,
  // and agents running on this machine right now.
  const threads = useThreadShells();
  const work = useMemo(() => buildReportWork(threads), [threads]);

  // Archiving is written to PostHog and confirmed by the next list fetch; the
  // row leaves the list immediately so the reader keeps moving.
  const [statusOverrides, setStatusOverrides] = useState<Readonly<Record<string, string>>>({});
  // Per report, not one flag for the page: archiving one report must not
  // disable the controls on the card that slides up behind it.
  const [busyReportIds, setBusyReportIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedReportId, setFocusedReportId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Reports the reader has taken themselves off. PostHog's own answer only
  // changes on the next reports fetch, so the pass and the For-you list carry
  // the decision until then — the same way archiving carries its status.
  const [handedBackReportIds, setHandedBackReportIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [creatingSection, setCreatingSection] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const reports = useMemo(() => {
    const fetched = reportsQuery.data?.reports ?? [];
    return fetched.map((report) => {
      const status = statusOverrides[report.id] ?? report.status;
      const isSuggestedReviewer = handedBackReportIds.has(report.id)
        ? false
        : report.is_suggested_reviewer;
      // Identity preserved where nothing was overridden: these rows feed every
      // memo below, and a fresh object per report per render is a re-render of
      // the whole list.
      return status === report.status && isSuggestedReviewer === report.is_suggested_reviewer
        ? report
        : { ...report, status, is_suggested_reviewer: isSuggestedReviewer };
    });
  }, [handedBackReportIds, reportsQuery.data, statusOverrides]);

  // A local override outranks the server so a decision shows the instant it is
  // made. Once PostHog's own answer agrees, the override has nothing left to
  // say — and leaving it in place would quietly outrank a later change made
  // anywhere else, for the life of the session.
  useEffect(() => {
    const fetched = reportsQuery.data?.reports;
    if (fetched === undefined) return;
    setStatusOverrides((current) => {
      let settled = false;
      const next = { ...current };
      for (const report of fetched) {
        if (next[report.id] === report.status) {
          delete next[report.id];
          settled = true;
        }
      }
      return settled ? next : current;
    });
    setHandedBackReportIds((current) => {
      if (current.size === 0) return current;
      let settled = false;
      const next = new Set(current);
      for (const report of fetched) {
        if (next.has(report.id) && report.is_suggested_reviewer !== true) {
          next.delete(report.id);
          settled = true;
        }
      }
      return settled ? next : current;
    });
  }, [reportsQuery.data]);

  const sections = useMemo(
    () =>
      view === "done"
        ? buildDoneSections(reports)
        : buildInboxSections(reports, customSections, { showNotActionable, scope, work }).filter(
            (group) => group.reports.length > 0 || !group.builtIn,
          ),
    [customSections, reports, scope, showNotActionable, view, work],
  );

  const [collapsedSectionIds, setCollapsedSectionIds] = useState<ReadonlySet<string>>(
    () => new Set(sections.filter((group) => group.defaultCollapsed).map((group) => group.id)),
  );
  const isCollapsed = useCallback(
    (group: InboxSectionGroup) => collapsedSectionIds.has(group.id),
    [collapsedSectionIds],
  );
  const [sectionLimits, setSectionLimits] = useState<Readonly<Record<string, number>>>({});
  const revealMore = useCallback((id: string) => {
    setSectionLimits((current) => ({
      ...current,
      [id]: (current[id] ?? SECTION_PAGE_SIZE) + SECTION_PAGE_SIZE,
    }));
  }, []);

  // One place decides what is on screen, so the rows, the keyboard order, and
  // the reveal control can never disagree about it.
  const visibleBySection = useMemo(() => {
    const entries = new Map<string, ReturnType<typeof visibleSectionReports>>();
    for (const group of sections) {
      entries.set(
        group.id,
        collapsedSectionIds.has(group.id)
          ? { visible: [], hiddenCount: group.reports.length, nextRevealCount: 0 }
          : visibleSectionReports(group.reports, sectionLimits[group.id] ?? SECTION_PAGE_SIZE),
      );
    }
    return entries;
  }, [collapsedSectionIds, sectionLimits, sections]);

  const toggleSection = useCallback((id: string) => {
    setCollapsedSectionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Rows out of sight — folded away or below a section's cap — are rows j/k
  // must not walk into.
  const orderedIds = useMemo<ReadonlyArray<string>>(
    () =>
      sections.flatMap((section) =>
        (visibleBySection.get(section.id)?.visible ?? []).map((report) => String(report.id)),
      ),
    [sections, visibleBySection],
  );

  // Counted across every section, folded ones included: whether the inbox is
  // empty is a fact about the reports, not about what the reader has folded.
  const reportCount = useMemo(
    () => sections.reduce((sum, section) => sum + section.reports.length, 0),
    [sections],
  );

  /** Reports that are asking for something, in list order. Triage walks these. */
  const decisionQueue = useMemo(
    () =>
      sections
        .filter((section) => !section.builtIn || DECISION_SECTION_IDS.has(section.id))
        .flatMap((section) => section.reports)
        // A report handed back is not asking the reader for anything, whatever
        // scope the list is in. It leaves the pass the moment they say so.
        .filter((report) => !handedBackReportIds.has(report.id)),
    [handedBackReportIds, sections],
  );

  useEffect(() => {
    if (orderedIds.length === 0) {
      setFocusedReportId(null);
      return;
    }
    setFocusedReportId((current) =>
      current !== null && orderedIds.includes(current) ? current : (orderedIds[0] ?? null),
    );
  }, [orderedIds]);

  useEffect(() => {
    if (focusedReportId === null || triageActive) return;
    listRef.current
      ?.querySelector(`[data-report-row="${CSS.escape(focusedReportId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedReportId, triageActive]);

  const changeState = useCallback(
    async (report: PostHogReport, state: "suppressed" | "potential"): Promise<boolean> => {
      if (busyReportIds.has(report.id)) return false;
      setBusyReportIds((current) => new Set(current).add(report.id));
      setActionError(null);
      setFocusedReportId(nextFocusedReportId(orderedIds, report.id));
      setStatusOverrides((current) => ({ ...current, [report.id]: state }));
      const result = await setReportState({
        environmentId,
        input: { reportId: report.id, state },
      });
      setBusyReportIds((current) => {
        const next = new Set(current);
        next.delete(report.id);
        return next;
      });
      if (result._tag === "Failure") {
        setStatusOverrides((current) => {
          const next = { ...current };
          delete next[report.id];
          return next;
        });
        setActionError(
          state === "suppressed"
            ? "Could not archive the report."
            : "Could not restore the report.",
        );
        return false;
      }
      refreshReports();
      return true;
    },
    [busyReportIds, environmentId, orderedIds, refreshReports, setReportState],
  );

  /**
   * Takes the reader off a report's reviewers. Optimistic like archiving: the
   * list stops calling the report theirs before PostHog answers, and puts it
   * back if PostHog refuses.
   */
  const handBack = useCallback(
    async (
      report: PostHogReport,
      remainingReviewers: ReadonlyArray<{ readonly github_login: string }>,
    ): Promise<boolean> => {
      setActionError(null);
      setHandedBackReportIds((current) => new Set(current).add(report.id));
      const result = await setReviewers({
        environmentId,
        input: { reportId: report.id, content: remainingReviewers },
      });
      if (result._tag === "Failure") {
        setHandedBackReportIds((current) => {
          const next = new Set(current);
          next.delete(report.id);
          return next;
        });
        return false;
      }
      refreshReports();
      return true;
    },
    [environmentId, refreshReports, setReviewers],
  );

  const saveSections = useCallback(
    (next: ReadonlyArray<(typeof customSections)[number]>) => {
      updateSettings({ posthog: { inboxSections: next } });
    },
    [updateSettings],
  );

  const focusedReport = useMemo(
    () => reports.find((report) => report.id === focusedReportId) ?? null,
    [focusedReportId, reports],
  );

  const makeHandlers = useCallback(
    (report: PostHogReport, pass: TriagePassControls): ReportDecisionHandlers => ({
      onImplement: (direction) =>
        openReport(report, {
          intent: direction.length > 0 ? `${IMPLEMENT_INTENT}\n\n${direction}` : IMPLEMENT_INTENT,
        }),
      onAnswer: (answer) => openReport(report, { intent: answer }),
      onAsk: () => openReport(report),
      onContinue: () => openReport(report),
      // Triage has no room for a diff; reviewing opens the report's page,
      // which does.
      onReviewPullRequest: () =>
        void navigate({ to: "/inbox/$reportId", params: { reportId: report.id } }),
      onOpenPullRequestExternally: () => {
        const url = report.implementation_pr_url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      },
      onArchive: () => {
        // Out of the pass first, then the request. A refusal is the only case
        // where the card was wrong to leave, and it still needs a decision.
        pass.rule();
        void changeState(report, "suppressed").then((landed) => {
          if (!landed) pass.restore();
        });
      },
    }),
    [changeState, navigate, openReport],
  );

  useEffect(() => {
    if (triageActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }
      if (event.key === "t" && view === "inbox" && decisionQueue.length > 0) {
        event.preventDefault();
        beginTriage(decisionQueue.map((report) => report.id));
        return;
      }
      if (event.key !== "j" && event.key !== "k" && event.key !== "Enter" && event.key !== "e") {
        return;
      }
      event.preventDefault();
      if (event.key === "j" || event.key === "k") {
        setFocusedReportId((current) => {
          if (orderedIds.length === 0) return null;
          const index = current === null ? -1 : orderedIds.indexOf(current);
          const nextIndex =
            event.key === "j" ? Math.min(index + 1, orderedIds.length - 1) : Math.max(index - 1, 0);
          return orderedIds[nextIndex] ?? current;
        });
        return;
      }
      if (focusedReport === null) return;
      if (event.key === "Enter") {
        void navigate({ to: "/inbox/$reportId", params: { reportId: focusedReport.id } });
        return;
      }
      void changeState(focusedReport, view === "done" ? "potential" : "suppressed");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    beginTriage,
    changeState,
    decisionQueue,
    focusedReport,
    navigate,
    orderedIds,
    triageActive,
    view,
  ]);

  usePrefetchFocusedReport(environmentId, focusedReportId);

  // Triage must not open on a card it has to go and fetch. The head of the
  // decision queue is where `t` lands, and the reader's own login is what
  // every card checks itself against — both are warmed here, once the list
  // itself has settled, so the mode opens complete.
  usePostHogViewerLogin(environmentId);
  const warmHeadKey = useSettled(
    triageActive || decisionQueue.length === 0
      ? null
      : decisionQueue
          .slice(0, TRIAGE_WARM_HEAD)
          .map((report) => report.id)
          .join(" "),
    600,
  );
  const warmHeadIds = useMemo(
    () =>
      warmHeadKey === null
        ? []
        : decisionQueue.slice(0, TRIAGE_WARM_HEAD).map((report) => report.id),
    [decisionQueue, warmHeadKey],
  );

  const editingSection = customSections.find((section) => section.id === editingSectionId) ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ReportArtefactWarmup environmentId={environmentId} reportIds={warmHeadIds} />
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
        <h1 className="text-sm font-semibold">{VIEW_TITLES[view]}</h1>
        {view === "inbox" && !triageActive ? (
          <div
            role="group"
            aria-label="Whose reports"
            className="ms-3 flex items-center rounded-[var(--control-radius)] bg-muted/60 p-0.5 text-xs"
          >
            {SCOPE_OPTIONS.map((option) => (
              <Tooltip key={option.value}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={scope === option.value}
                      onClick={() => setScope(option.value)}
                      className={cn(
                        "rounded-[calc(var(--control-radius)-2px)] px-2 py-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        scope === option.value
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{option.hint}</TooltipPopup>
              </Tooltip>
            ))}
          </div>
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          {view === "inbox" && !triageActive ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  // `aria-disabled` rather than `disabled`: a disabled button
                  // emits no pointer events, so the tooltip explaining why it
                  // is unavailable would never appear.
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-disabled={decisionQueue.length === 0}
                    className="aria-disabled:cursor-default aria-disabled:opacity-64 aria-disabled:hover:bg-transparent"
                    onClick={() =>
                      decisionQueue.length > 0 &&
                      beginTriage(decisionQueue.map((report) => report.id))
                    }
                  >
                    <ListChecksIcon className="size-3.5" />
                    Triage
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                {decisionQueue.length === 0 ? (
                  "Nothing is waiting on a decision right now"
                ) : (
                  <span className="flex items-center gap-1.5">
                    One report at a time <Kbd>t</Kbd>
                  </span>
                )}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  aria-label="Refresh reports"
                  disabled={reportsQuery.isPending}
                  onClick={refreshReports}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-3.5",
                      reportsQuery.isPending && "animate-spin motion-reduce:animate-none",
                    )}
                  />
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {reportsQuery.isPending ? "Fetching reports…" : "Refresh"}
            </TooltipPopup>
          </Tooltip>
          {view === "inbox" ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="icon-micro" variant="ghost" aria-label="Inbox options">
                    <EllipsisIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    updateSettings({
                      posthog: { showNotActionableReports: !showNotActionable },
                    })
                  }
                >
                  {showNotActionable ? "Hide" : "Show"} reports with nothing to do
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </WorkspacePageHeader>

      {(actionError ?? openError) ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-border/50 px-4 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1">{actionError ?? openError}</span>
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => {
              setActionError(null);
              dismissError();
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {reportsQuery.error ? (
        <PostHogErrorState error={reportsQuery.error} />
      ) : triageActive && view === "inbox" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TriageFocus
            environmentId={environmentId}
            reports={reports}
            decisionQueue={decisionQueue}
            busyReportIds={busyReportIds}
            onActionError={setActionError}
            onHandBack={handBack}
            onExit={endTriage}
            onOpenReport={(report) =>
              void navigate({ to: "/inbox/$reportId", params: { reportId: report.id } })
            }
            makeHandlers={makeHandlers}
          />
        </div>
      ) : reportsQuery.isPending && reports.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState hoggie="loading" title="Loading reports" />
        </div>
      ) : reportCount === 0 && customSections.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          {view === "done" ? (
            <EmptyState hoggie="done" title="Nothing archived yet" />
          ) : (
            <EmptyState
              hoggie="inboxZero"
              title="Inbox zero"
              body="New reports show up here as PostHog finds them."
            />
          )}
        </div>
      ) : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-4">
            {sections.map((group) => (
              <section key={group.id} className="mt-7 first:mt-0">
                <SectionHeading
                  group={group}
                  collapsed={isCollapsed(group)}
                  onToggle={() => toggleSection(group.id)}
                  onEdit={group.builtIn ? null : () => setEditingSectionId(group.id)}
                />
                {isCollapsed(group) ? null : group.reports.length === 0 ? (
                  <p className="px-3 py-1.5 text-xs text-muted-foreground/70">
                    {group.description}
                  </p>
                ) : (
                  (visibleBySection.get(group.id)?.visible ?? []).map((report) => (
                    <ReportRow
                      key={report.id}
                      report={report}
                      work={work.get(report.id) ?? NO_WORK}
                      showsRouting={scope === "everyone"}
                      unread={isReportUnread(report, seen)}
                      focused={focusedReportId === report.id}
                      busy={busyReportIds.has(report.id)}
                      closed={view === "done"}
                      onFocus={() => setFocusedReportId(report.id)}
                      onOpen={() =>
                        void navigate({
                          to: "/inbox/$reportId",
                          params: { reportId: report.id },
                        })
                      }
                      onArchive={() => void changeState(report, "suppressed")}
                      onRestore={() => void changeState(report, "potential")}
                    />
                  ))
                )}
                {!isCollapsed(group) && (visibleBySection.get(group.id)?.hiddenCount ?? 0) > 0 ? (
                  <button
                    type="button"
                    onClick={() => revealMore(group.id)}
                    className="ms-3 rounded-[var(--control-radius)] px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Show {visibleBySection.get(group.id)?.nextRevealCount} more
                    <span className="ms-1.5 tabular-nums opacity-60">
                      {visibleBySection.get(group.id)?.hiddenCount} hidden
                    </span>
                  </button>
                ) : null}
              </section>
            ))}

            {view === "inbox" ? (
              <button
                type="button"
                onClick={() => setCreatingSection(true)}
                className={cn(
                  "mt-7 flex items-center gap-1.5 rounded-[var(--control-radius)] px-3 py-1.5",
                  "text-xs text-muted-foreground outline-none hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <PlusIcon className="size-3.5" />
                New section
              </button>
            ) : null}
          </div>
        </div>
      )}

      {creatingSection ? (
        <SectionEditorDialog
          open
          onOpenChange={(open) => !open && setCreatingSection(false)}
          section={null}
          reports={reports}
          onDelete={null}
          onSave={(label, filter: PostHogInboxFilter) =>
            saveSections([
              ...customSections,
              { id: nextCustomSectionId(customSections), label, filter, collapsed: false },
            ])
          }
        />
      ) : null}

      {editingSection ? (
        <SectionEditorDialog
          open
          onOpenChange={(open) => !open && setEditingSectionId(null)}
          section={editingSection}
          reports={reports}
          onDelete={() =>
            saveSections(customSections.filter((section) => section.id !== editingSection.id))
          }
          onSave={(label, filter: PostHogInboxFilter) =>
            saveSections(
              customSections.map((section) =>
                section.id === editingSection.id ? { ...section, label, filter } : section,
              ),
            )
          }
        />
      ) : null}
    </SidebarInset>
  );
}
