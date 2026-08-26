/**
 * One report at a time, keyboard-driven: the fast way through a queue of
 * decisions. Walks the reports that are asking for something, in the list's
 * own order.
 *
 * Engaging a report advances to the next one rather than ending the pass.
 * You started a run; the agent does not need you watching it, and the queue
 * is the session. Leaving triage should be a choice, not a side effect of
 * doing the thing triage exists for.
 */
import type { EnvironmentId, PostHogReport } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, MaximizeIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyState } from "../../brand/EmptyState";
import { postHogEnvironment } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readReportArtefacts } from "../reports/reportArtefacts";
import ChatMarkdown from "../ChatMarkdown";
import { PriorityChip } from "../reports/PriorityChip";
import { ReportDecision, type ReportDecisionHandlers } from "../reports/ReportDecision";
import { splitReportSummary } from "../reports/reportVerdict";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { humanizeReportTitle, sourceProductLabel } from "./inboxList.logic";

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

export function TriageFocus({
  environmentId,
  reports,
  busy,
  onExit,
  onOpenReport,
  makeHandlers,
}: {
  readonly environmentId: EnvironmentId;
  /** The decision queue, in the list's order. Shrinks as reports are handled. */
  readonly reports: ReadonlyArray<PostHogReport>;
  readonly busy: boolean;
  readonly onExit: () => void;
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

  // One card is on screen at a time, so this is one request per report read —
  // and it carries the reasoning behind a verdict the reader would otherwise
  // have to leave the card to check.
  const artefactsQuery = useEnvironmentQuery(
    report === undefined
      ? null
      : postHogEnvironment.artefacts({ environmentId, input: { reportId: report.id } }),
  );
  const artefactView = useMemo(
    () => readReportArtefacts(artefactsQuery.data?.artefacts ?? []),
    [artefactsQuery.data],
  );

  const goNext = useCallback(
    () => setIndex((current) => Math.min(current + 1, reports.length - 1)),
    [reports.length],
  );
  const goPrevious = useCallback(() => setIndex((current) => Math.max(current - 1, 0)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        goNext();
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        goPrevious();
      } else if (event.key === "Enter") {
        if (event.target instanceof HTMLElement && event.target.closest("button, a[href]")) return;
        event.preventDefault();
        if (report !== undefined) onOpenReport(report);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goNext, goPrevious, onExit, onOpenReport, report]);

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
    setIndex(clamped);
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-5">
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

      <article className="rounded-lg border border-border bg-card p-5">
        <button
          type="button"
          onClick={() => onOpenReport(report)}
          className="text-start text-base font-semibold leading-snug hover:underline"
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
          <div className="mt-3 text-sm leading-relaxed">
            <ChatMarkdown text={summary.lede} cwd={undefined} className="[&_p]:my-2" />
          </div>
        ) : null}

        <ReportDecision
          key={report.id}
          reasoning={artefactView.actionability?.explanation ?? null}
          repository={artefactView.repoSelection?.repository ?? null}
          report={report}
          hasExistingPr={Boolean(report.implementation_pr_url)}
          busy={busy}
          className="mt-4"
          handlers={handlers}
        />
      </article>

      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
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
