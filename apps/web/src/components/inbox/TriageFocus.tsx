/**
 * One report at a time, keyboard-driven: the fast way through a queue of
 * decisions. Walks the deck the pass captured when it began, in that order.
 *
 * Engaging a report advances to the next one rather than ending the pass.
 * You started a run; the agent does not need you watching it, and the queue
 * is the session. Leaving triage should be a choice, not a side effect of
 * doing the thing triage exists for.
 *
 * Nothing moves under the cursor. The deck's membership and order are frozen
 * for the pass and the cursor is a report id rather than a position, so a
 * refetch cannot slide a different report into the slot the reader is ruling
 * on; each id still resolves live, so a report handled somewhere else shows
 * its new verdict when they reach it. Only the reader's own decisions remove
 * a card, and a decision that does not land puts it back.
 *
 * A card is dealt whole or not at all. Everything on it that comes from the
 * report's artefacts — the agent's reasoning, the repository it chose, whether
 * it named you a reviewer — is fetched for the reports ahead of the reader, so
 * the card that arrives is the card that stays.
 */
import type { EnvironmentId, PostHogReport } from "@t3tools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MaximizeIcon,
  PlusIcon,
  UserMinusIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../../brand/EmptyState";
import { isMacPlatform } from "../../lib/utils";
import { postHogEnvironment } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readReportArtefacts } from "../reports/reportArtefacts";
import ChatMarkdown from "../ChatMarkdown";
import { ClampedBlock } from "../reports/ClampedBlock";
import { PriorityChip } from "../reports/PriorityChip";
import {
  ReportDecision,
  type ReportDecisionControls,
  type ReportDecisionHandlers,
} from "../reports/ReportDecision";
import { ReportArtefactWarmup, usePostHogViewerLogin } from "../reports/reportWarmup";
import { deriveReportDecision, splitReportSummary } from "../reports/reportVerdict";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { humanizeReportTitle, sourceProductLabel } from "./inboxList.logic";
import { useTriageStore } from "./triageStore";

/**
 * A card's own door out of the pass, handed to whoever commits the decision.
 * Both directions, because a decision that does not land leaves a report that
 * still needs one.
 */
export interface TriagePassControls {
  /** Take this report out of the pass; the next card slides into its slot. */
  readonly rule: () => void;
  /** Put it back, where the request behind the decision was refused. */
  readonly restore: () => void;
}

/** How far ahead of the reader the queue's evidence is fetched. */
const WARM_AHEAD = 3;

/** The key handler takes either modifier; only the legend has to pick one. */
const MOD_LABEL = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/**
 * The card before its evidence lands: the same shapes in the same places, so
 * the wait resolves into text rather than replacing an empty box with a card.
 * Static bars rather than a shimmer — this is a rare state on a surface whose
 * whole promise is that nothing repaints between decisions.
 */
function TriageCardPlaceholder() {
  return (
    <>
      <span className="sr-only">Reading the report</span>
      <div aria-hidden className="flex flex-1 flex-col">
        <div className="h-4 w-3/5 rounded-sm bg-muted" />
        <div className="mt-3 flex items-center gap-2">
          <div className="h-3 w-10 rounded-sm bg-muted" />
          <div className="h-3 w-16 rounded-sm bg-muted" />
          <div className="h-3 w-12 rounded-sm bg-muted" />
        </div>
        <div className="mt-5 space-y-2">
          <div className="h-3 w-full rounded-sm bg-muted" />
          <div className="h-3 w-full rounded-sm bg-muted" />
          <div className="h-3 w-4/5 rounded-sm bg-muted" />
        </div>
        {/* The verdict's own frame, held where the verdict will be. */}
        <div className="mt-auto rounded-lg border border-border bg-muted/40 p-3.5">
          <div className="h-3 w-2/5 rounded-sm bg-muted" />
          <div className="mt-2 h-3 w-4/5 rounded-sm bg-muted" />
          <div className="mt-3.5 flex gap-2">
            <div className="h-7 w-28 rounded-[var(--control-radius)] bg-muted" />
            <div className="h-7 w-20 rounded-[var(--control-radius)] bg-muted" />
          </div>
        </div>
      </div>
    </>
  );
}

export function TriageFocus({
  environmentId,
  reports,
  decisionQueue,
  busyReportIds,
  onExit,
  onActionError,
  onHandBack,
  onOpenReport,
  makeHandlers,
}: {
  readonly environmentId: EnvironmentId;
  /** Every report the page holds, live. The deck resolves its ids against it,
   *  so a report changed elsewhere shows its new verdict when reached. */
  readonly reports: ReadonlyArray<PostHogReport>;
  /** What is asking for a decision right now. Only used to count what has
   *  arrived since the pass began; the pass itself walks its own deck. */
  readonly decisionQueue: ReadonlyArray<PostHogReport>;
  /** Reports with a state change in flight. Held per report so a decision on
   *  the last card cannot disable the controls on the next one. */
  readonly busyReportIds: ReadonlySet<string>;
  readonly onExit: () => void;
  /** Says what went wrong where the page already shows its failures. */
  readonly onActionError: (message: string) => void;
  /** Takes the reader off the report's reviewers. Resolves false when PostHog
   *  refused, which is the only case where the card was wrong to leave. */
  readonly onHandBack: (
    report: PostHogReport,
    remainingReviewers: ReadonlyArray<{ readonly github_login: string }>,
  ) => Promise<boolean>;
  /** Leaves the card for the report's full page, evidence and all. */
  readonly onOpenReport: (report: PostHogReport) => void;
  /** Built per report so each card commits against the report it shows. */
  readonly makeHandlers: (
    report: PostHogReport,
    pass: TriagePassControls,
  ) => ReportDecisionHandlers;
}) {
  const deckIds = useTriageStore((state) => state.deckIds);
  const cursorId = useTriageStore((state) => state.cursorId);
  const ruled = useTriageStore((state) => state.ruled);
  const setCursor = useTriageStore((state) => state.setCursor);
  const pickUp = useTriageStore((state) => state.pickUp);
  const ruleReport = useTriageStore((state) => state.rule);
  const unruleReport = useTriageStore((state) => state.unrule);

  const reportsById = useMemo(
    () => new Map<string, PostHogReport>(reports.map((entry) => [entry.id, entry])),
    [reports],
  );

  // The deck: the ids the pass captured, in that order, resolved live. A
  // report the reader has ruled on leaves; one PostHog stopped returning
  // leaves because there is nothing left to draw. Nothing else moves.
  const deck = useMemo(
    () =>
      deckIds
        .filter((id) => !ruled.has(id))
        .map((id) => reportsById.get(id))
        .filter((entry): entry is PostHogReport => entry !== undefined),
    [deckIds, reportsById, ruled],
  );

  // Reports that started asking for a decision after the pass began. Counted,
  // never spliced in: the reader decides when their queue grows.
  const arrived = useMemo(() => {
    const held = new Set(deckIds);
    return decisionQueue.filter((entry) => !held.has(entry.id));
  }, [decisionQueue, deckIds]);

  // The cursor is an id, so a refetch cannot slide a different report under
  // it. The remembered position is the fallback for the one case an id cannot
  // survive: the report it names is gone.
  const lastPosition = useRef(0);
  const anchored = deck.findIndex((entry) => entry.id === cursorId);
  const position = anchored >= 0 ? anchored : Math.min(lastPosition.current, deck.length - 1);
  const report = position >= 0 ? deck[position] : undefined;

  useEffect(() => {
    if (report === undefined) return;
    lastPosition.current = position;
    if (report.id !== cursorId) setCursor(report.id);
  }, [cursorId, position, report, setCursor]);

  const summary = useMemo(() => splitReportSummary(report?.summary), [report?.summary]);
  // Which way the reader last moved, so the card arrives from where the last
  // one left.
  const [direction, setDirection] = useState<"next" | "previous">("next");
  const busy = report !== undefined && busyReportIds.has(report.id);
  const controls = useRef<ReportDecisionControls | null>(null);

  const artefactsQuery = useEnvironmentQuery(
    report === undefined
      ? null
      : postHogEnvironment.artefacts({ environmentId, input: { reportId: report.id } }),
  );
  const artefactView = useMemo(
    () => readReportArtefacts(artefactsQuery.data?.artefacts ?? []),
    [artefactsQuery.data],
  );
  // A failed fetch still deals the card: the reader came here to rule on
  // reports, and losing the agent's justification is not a reason to stop
  // them. Only an answer still in flight holds the card back.
  const dealt = artefactsQuery.data !== null || artefactsQuery.error !== null;
  // The reports the reader is about to reach, fetched while they read this
  // one. One behind as well: stepping back must be as cheap as going on.
  const warmIds = useMemo(
    () =>
      deck
        .slice(Math.max(0, position - 1), position + 1 + WARM_AHEAD)
        .map((entry) => entry.id)
        .filter((id) => id !== report?.id),
    [deck, position, report?.id],
  );

  // The reader's own GitHub login is what matches them to a reviewer row:
  // PostHog keys `suggested_reviewers` entries by login, and the report's
  // `is_suggested_reviewer` is a boolean that cannot say *which* row is theirs.
  const myLogin = usePostHogViewerLogin(environmentId);
  const mine =
    myLogin !== null &&
    artefactView.reviewers.some((reviewer) => reviewer.github_login.toLowerCase() === myLogin);
  const canUnassign = report !== undefined && mine && !busy;

  const goNext = useCallback(() => {
    const next = deck[position + 1];
    if (next === undefined) return;
    setDirection("next");
    setCursor(next.id);
  }, [deck, position, setCursor]);
  const goPrevious = useCallback(() => {
    const previous = deck[position - 1];
    if (previous === undefined) return;
    setDirection("previous");
    setCursor(previous.id);
  }, [deck, position, setCursor]);

  /**
   * Takes a report out of the pass. The cursor moves first, off the id that is
   * about to leave and onto the one that follows it, so the removal can never
   * orphan it — the next card slides into the slot rather than the reader
   * being teleported to whatever the deck reshuffled into it.
   */
  const rule = useCallback(
    (reportId: string) => {
      const leaving = deck.findIndex((entry) => entry.id === reportId);
      if (leaving >= 0) {
        const successor = deck[leaving + 1] ?? deck[leaving - 1] ?? null;
        setDirection("next");
        setCursor(successor?.id ?? null);
      }
      ruleReport(reportId);
    },
    [deck, ruleReport, setCursor],
  );

  const unassignMe = useCallback(() => {
    if (report === undefined || myLogin === null) return;
    // A full replacement, so it is built from the reviewers actually on the
    // report — never from an empty list that has not loaded yet.
    const remaining = artefactView.reviewers
      .filter((reviewer) => reviewer.github_login.toLowerCase() !== myLogin)
      .map((reviewer) => ({ github_login: reviewer.github_login }));
    const handed = report;
    // Taken at its word: the report leaves the pass now and the request
    // catches up behind it. Put back if PostHog refuses, which is the only
    // case where the card was wrong to leave.
    rule(handed.id);
    void onHandBack(handed, remaining).then((landed) => {
      if (landed) return;
      unruleReport(handed.id);
      onActionError("Could not take you off the report's reviewers.");
    });
  }, [artefactView.reviewers, myLogin, onActionError, onHandBack, report, rule, unruleReport]);

  // What this report is asking for, in the legend's words. Derived from the
  // same function the card's controls are, so the key and the button it fires
  // can never disagree about what they do.
  const decision = useMemo(
    () =>
      report === undefined
        ? null
        : deriveReportDecision(report, { hasExistingPr: Boolean(report.implementation_pr_url) }),
    [report],
  );
  const primaryLabel = decision?.primary?.label ?? null;
  const canArchive =
    decision !== null &&
    (decision.primary?.kind === "archive" ||
      decision.secondary.some((action) => action.kind === "archive"));
  const canReply = decision?.primary?.kind === "answer";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const typing = isTypingTarget(event.target);

      // Escape is the only key the field does not own: it hands the keyboard
      // back to the card. Leaving triage takes a second press, which is the
      // right price for a mode you meant to be in.
      if (event.key === "Escape") {
        event.preventDefault();
        if (typing && event.target instanceof HTMLElement) {
          event.target.blur();
          return;
        }
        onExit();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key === "Enter" && !typing) {
          if (controls.current?.runPrimary() === true) event.preventDefault();
        }
        return;
      }
      if (event.altKey || typing) return;

      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        goNext();
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        goPrevious();
      } else if (event.key === "r") {
        if (controls.current?.focusInput() === true) event.preventDefault();
      } else if (event.key === "e") {
        if (controls.current?.runArchive() === true) event.preventDefault();
      } else if (event.key === "m") {
        if (!canUnassign) return;
        event.preventDefault();
        unassignMe();
      } else if (event.key === "Enter") {
        if (event.target instanceof HTMLElement && event.target.closest("button, a[href]")) return;
        event.preventDefault();
        if (report !== undefined) onOpenReport(report);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canUnassign, goNext, goPrevious, onExit, onOpenReport, report, unassignMe]);

  if (report === undefined) {
    // Reports that arrived mid-pass are the one thing standing between "every
    // decision made" and the truth, so the way to take them is offered here
    // rather than only in the header the empty deck has replaced.
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          hoggie="inboxZero"
          title="Every decision made"
          body={
            arrived.length > 0
              ? `${arrived.length} report${arrived.length === 1 ? "" : "s"} arrived while you were working.`
              : "Nothing left in the queue."
          }
          action={
            <div className="flex items-center gap-2">
              {arrived.length > 0 ? (
                <Button size="sm" onClick={() => pickUp(arrived.map((entry) => entry.id))}>
                  <PlusIcon className="size-3.5" />
                  Take {arrived.length === 1 ? "it" : "them"}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={onExit}>
                Back to the inbox
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const handlers = makeHandlers(report, {
    rule: () => rule(report.id),
    restore: () => unruleReport(report.id),
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-5">
      <ReportArtefactWarmup environmentId={environmentId} reportIds={warmIds} />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous report"
            disabled={position <= 0}
            onClick={goPrevious}
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next report"
            disabled={position >= deck.length - 1}
            onClick={goNext}
          >
            <ChevronRightIcon className="size-3.5" />
          </Button>
          <span className="ms-1 text-xs tabular-nums text-muted-foreground">
            {position + 1} of {deck.length}
          </span>
          {/* The deck is frozen for the pass, so what has arrived since is
              said plainly rather than appearing in the queue unannounced. */}
          {arrived.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="ms-1 text-muted-foreground"
              onClick={() => pickUp(arrived.map((entry) => entry.id))}
            >
              <PlusIcon className="size-3.5" />
              {arrived.length} new
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {canUnassign ? (
            <Button size="sm" variant="outline" onClick={unassignMe}>
              <UserMinusIcon className="size-3.5" />
              Not mine
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => onOpenReport(report)}>
            <MaximizeIcon className="size-3.5" />
            Open report
          </Button>
          <Button size="sm" variant="ghost" onClick={onExit}>
            <XIcon className="size-3.5" />
            Exit
          </Button>
        </div>
      </div>

      {/* One frame, whatever is in it. The card is the same size and the
          decision sits on the same line for every report in the pass, so the
          reader's eye and cursor stay where they were. */}
      <article
        key={report.id}
        data-triage-card={direction}
        aria-busy={dealt ? undefined : true}
        className="flex min-h-76 flex-col rounded-lg border border-border bg-card p-5"
      >
        {dealt ? (
          <>
            <button
              type="button"
              onClick={() => onOpenReport(report)}
              className="line-clamp-2 rounded-sm text-start text-base font-semibold leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {humanizeReportTitle(report.title)}
            </button>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {report.priority ? <PriorityChip priority={report.priority} /> : null}
              {report.source_products[0] ? (
                <span>{sourceProductLabel(report.source_products[0])}</span>
              ) : null}
              {report.signal_count ? (
                <span className="tabular-nums">
                  {report.signal_count} signal{report.signal_count === 1 ? "" : "s"}
                </span>
              ) : null}
              <span className="tabular-nums">{formatRelativeTimeLabel(report.updated_at)}</span>
            </div>

            {/* Triage reads the gist and the argument; the proof lives on the
                report's own page, one keystroke away. */}
            {summary.lede ? (
              <ClampedBlock lines={5} className="mt-3 text-sm leading-relaxed">
                <ChatMarkdown text={summary.lede} cwd={undefined} className="[&_p]:my-2" />
              </ClampedBlock>
            ) : null}

            {/* Pushed to the foot of the frame, so the verdict and its controls
                land on the same line for every report in the pass. */}
            <div className="mt-auto pt-4">
              <ReportDecision
                controls={controls}
                reasoning={artefactView.actionability?.explanation ?? null}
                repository={artefactView.repoSelection?.repository ?? null}
                report={report}
                hasExistingPr={Boolean(report.implementation_pr_url)}
                busy={busy}
                handlers={handlers}
              />
            </div>
          </>
        ) : (
          <TriageCardPlaceholder />
        )}
      </article>

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
        {primaryLabel ? (
          <span className="flex items-center gap-1">
            <Kbd>{MOD_LABEL}</Kbd>
            <Kbd>↵</Kbd> {primaryLabel.toLowerCase()}
          </span>
        ) : null}
        {canReply ? (
          <span className="flex items-center gap-1">
            <Kbd>r</Kbd> write a reply
          </span>
        ) : null}
        {canArchive ? (
          <span className="flex items-center gap-1">
            <Kbd>e</Kbd> archive
          </span>
        ) : null}
        {canUnassign ? (
          <span className="flex items-center gap-1">
            <Kbd>m</Kbd> not mine
          </span>
        ) : null}
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open the report
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> exit
        </span>
      </div>
    </div>
  );
}
