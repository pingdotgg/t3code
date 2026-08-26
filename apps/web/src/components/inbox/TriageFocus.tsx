/**
 * One report at a time, keyboard-driven: the fast way through a queue of
 * decisions. Walks the reports that are asking for something, in the list's
 * own order.
 *
 * Engaging a report advances to the next one rather than ending the pass.
 * You started a run; the agent does not need you watching it, and the queue
 * is the session. Leaving triage should be a choice, not a side effect of
 * doing the thing triage exists for.
 *
 * A card is dealt whole or not at all. Everything on it that comes from the
 * report's artefacts — the agent's reasoning, the repository it chose, whether
 * it named you a reviewer — is fetched for the reports ahead of the reader, so
 * the card that arrives is the card that stays. Nothing rewrites itself under
 * the cursor.
 */
import type { EnvironmentId, PostHogReport } from "@t3tools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MaximizeIcon,
  UserMinusIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../../brand/EmptyState";
import { isMacPlatform } from "../../lib/utils";
import { postHogEnvironment } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
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
  busyReportIds,
  onExit,
  onActionError,
  onHandBack,
  onOpenReport,
  makeHandlers,
}: {
  readonly environmentId: EnvironmentId;
  /** The decision queue, in the list's order. Shrinks as reports are handled. */
  readonly reports: ReadonlyArray<PostHogReport>;
  /** Reports with a state change in flight. Held per report so a decision on
   *  the last card cannot disable the controls on the next one. */
  readonly busyReportIds: ReadonlySet<string>;
  readonly onExit: () => void;
  /** Says what went wrong where the page already shows its failures. */
  readonly onActionError: (message: string) => void;
  /** Records that the reader is not a reviewer on this report, or takes it
   *  back when PostHog refuses. A handed-back report leaves the queue. */
  readonly onHandBack: (reportId: string, handedBack: boolean) => void;
  /** Leaves the card for the report's full page, evidence and all. */
  readonly onOpenReport: (report: PostHogReport) => void;
  /** Built per report so each card commits against the report it shows. */
  readonly makeHandlers: (report: PostHogReport, advance: () => void) => ReportDecisionHandlers;
}) {
  const [index, setIndex] = useState(0);
  // The queue shrinks underneath as reports are handled; clamping rather than
  // resetting is what makes handle-and-advance work.
  const clamped = Math.min(index, Math.max(0, reports.length - 1));
  const report = reports[clamped];
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
      reports
        .slice(Math.max(0, clamped - 1), clamped + 1 + WARM_AHEAD)
        .map((entry) => entry.id)
        .filter((id) => id !== report?.id),
    [clamped, report?.id, reports],
  );

  // The reader's own GitHub login is what matches them to a reviewer row:
  // PostHog keys `suggested_reviewers` entries by login, and the report's
  // `is_suggested_reviewer` is a boolean that cannot say *which* row is theirs.
  const myLogin = usePostHogViewerLogin(environmentId);
  const setReviewers = useAtomCommand(postHogEnvironment.setReviewers, { reportFailure: false });
  const mine =
    myLogin !== null &&
    artefactView.reviewers.some((reviewer) => reviewer.github_login.toLowerCase() === myLogin);
  const canUnassign = report !== undefined && mine && !busy;

  const goNext = useCallback(() => {
    setDirection("next");
    setIndex((current) => Math.min(current + 1, reports.length - 1));
  }, [reports.length]);
  const goPrevious = useCallback(() => {
    setDirection("previous");
    setIndex((current) => Math.max(current - 1, 0));
  }, []);

  const unassignMe = useCallback(() => {
    if (report === undefined || myLogin === null) return;
    // A full replacement, so it is built from the reviewers actually on the
    // report — never from an empty list that has not loaded yet.
    const next = artefactView.reviewers
      .filter((reviewer) => reviewer.github_login.toLowerCase() !== myLogin)
      .map((reviewer) => ({ github_login: reviewer.github_login }));
    const reportId = report.id;
    // Taken at its word. The report leaves the queue now and the next card
    // slides into this slot, the way archiving already works; the request
    // catches up behind it. Put back if PostHog refuses, which is the only
    // case where the card was wrong to leave.
    onHandBack(reportId, true);
    void (async () => {
      const result = await setReviewers({ environmentId, input: { reportId, content: next } });
      if (result._tag !== "Failure") return;
      onHandBack(reportId, false);
      onActionError("Could not take you off the report's reviewers.");
    })();
  }, [
    artefactView.reviewers,
    environmentId,
    myLogin,
    onActionError,
    onHandBack,
    report,
    setReviewers,
  ]);

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
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          hoggie="inboxZero"
          title="Every decision made"
          body="Nothing left in the queue."
          action={
            <Button size="sm" variant="outline" onClick={onExit}>
              Back to the inbox
            </Button>
          }
        />
      </div>
    );
  }

  const handlers = makeHandlers(report, () => {
    // Staying on the same index lands on whatever slid up into this slot.
    setDirection("next");
    setIndex(clamped);
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
            disabled={clamped === 0}
            onClick={goPrevious}
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next report"
            disabled={clamped >= reports.length - 1}
            onClick={goNext}
          >
            <ChevronRightIcon className="size-3.5" />
          </Button>
          <span className="ms-1 text-xs tabular-nums text-muted-foreground">
            {clamped + 1} of {reports.length}
          </span>
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
