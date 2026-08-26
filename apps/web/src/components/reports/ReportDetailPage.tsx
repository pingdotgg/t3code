/**
 * A report on its own page. The title, its gist, the argument, then the proof
 * — and the decision, which is the reason the page exists.
 *
 * The verdict renders here, not only in triage. This is the surface a reader
 * opens when the call is hard, and handing them a chat button instead of the
 * verbs is how a decision screen quietly becomes a reading screen.
 */
import type { EnvironmentId, PostHogReport, PullRequestRef } from "@t3tools/contracts";
import { postHogReportUrl } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, InboxIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { EmptyState } from "../../brand/EmptyState";
import { isElectron } from "../../env";
import { findProjectForChangeRequest, parseChangeRequestUrl } from "../../lib/openPullRequestLink";
import { useProjects } from "../../state/entities";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { useReportSeenStore } from "../../reportSeenStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { postHogEnvironment, reportsListAtom } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerSettingsAtom } from "../../state/server";
import { useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { humanizeReportTitle, sourceProductLabel } from "../inbox/inboxList.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PriorityChip } from "./PriorityChip";
import { readReportArtefacts } from "./reportArtefacts";
import {
  ReportDecision,
  type ReportDecisionControls,
  type ReportDecisionHandlers,
} from "./ReportDecision";
import { PriorityExplanation, ReportDocument } from "./ReportDocument";
import { IMPLEMENT_INTENT } from "./reportIntent";
import { usePostHogQuery } from "./reportsQuery";
import { reportThreads, useReportOpener } from "./useOpenReport";

export function ReportDetailPage({ reportId }: { readonly reportId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
          <h1 className="text-sm font-semibold">Report</h1>
        </WorkspacePageHeader>
        <p className="p-5 text-sm text-muted-foreground">Connect a server to read this report.</p>
      </SidebarInset>
    );
  }
  return <ConnectedReportDetailPage environmentId={environmentId} reportId={reportId} />;
}

function ConnectedReportDetailPage({
  environmentId,
  reportId,
}: {
  readonly environmentId: EnvironmentId;
  readonly reportId: string;
}) {
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const report = useMemo(
    () => reportsQuery.data?.reports.find((entry) => entry.id === reportId) ?? null,
    [reportId, reportsQuery.data],
  );

  if (report === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <ReportPageHeader />
        <div className="flex flex-1 items-center justify-center p-8">
          {reportsQuery.isPending ? (
            <EmptyState hoggie="loading" title="Loading the report" />
          ) : (
            <EmptyState
              hoggie="requestFailed"
              title="This report is no longer available"
              body="It may have been deleted in PostHog."
            />
          )}
        </div>
      </SidebarInset>
    );
  }

  return <LoadedReportDetail environmentId={environmentId} report={report} />;
}

function ReportPageHeader({ children }: { readonly children?: React.ReactNode }) {
  return (
    <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
      <Link
        to="/inbox"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <InboxIcon className="size-3.5" />
        Inbox
      </Link>
      {children}
    </WorkspacePageHeader>
  );
}

function LoadedReportDetail({
  environmentId,
  report,
}: {
  readonly environmentId: EnvironmentId;
  readonly report: PostHogReport;
}) {
  const navigate = useNavigate();
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const markSeen = useReportSeenStore((state) => state.markSeen);
  const { openReport, error: openError } = useReportOpener(environmentId);
  const setReportState = useAtomCommand(postHogEnvironment.setReportState, {
    reportFailure: false,
  });

  const artefactsQuery = useEnvironmentQuery(
    postHogEnvironment.artefacts({ environmentId, input: { reportId: report.id } }),
  );
  const signalsQuery = useEnvironmentQuery(
    postHogEnvironment.signals({ environmentId, input: { reportId: report.id } }),
  );

  const artefacts = artefactsQuery.data?.artefacts ?? [];
  const view = useMemo(() => readReportArtefacts(artefacts), [artefacts]);
  const projects = useProjects();
  const [reviewOpen, setReviewOpen] = useState(false);

  // The change request the report's implementation opened, resolved against a
  // repository this environment actually has checked out. Anything else — a
  // fork, another organisation, a host nothing here is cloned from — stays an
  // ordinary link out to the host.
  const pullRequestRef = useMemo<PullRequestRef | null>(() => {
    const url = report.implementation_pr_url;
    if (!url) return null;
    const link = parseChangeRequestUrl(url);
    if (link === null) return null;
    const project = findProjectForChangeRequest(
      projects.filter((candidate) => candidate.environmentId === environmentId),
      link,
    );
    if (project === undefined) return null;
    return { projectId: project.id, repository: link.repository, number: link.number };
  }, [environmentId, projects, report.implementation_pr_url]);
  const threads = useThreadShells();
  const conversations = useMemo(() => reportThreads(threads, report.id), [report.id, threads]);
  const hasExistingPr =
    Boolean(report.implementation_pr_url) ||
    conversations.some((thread) => thread.linkedPullRequest != null);

  useEffect(() => {
    markSeen(report.id, report.updated_at);
  }, [markSeen, report.id, report.updated_at]);

  const decisionControls = useRef<ReportDecisionControls | null>(null);
  useReportPageShortcuts(decisionControls);

  const reportUrl = postHogReportUrl({
    host: serverSettings.posthog.host,
    projectId: serverSettings.posthog.projectId,
    reportId: report.id,
  });

  const handlers: ReportDecisionHandlers = {
    onImplement: (direction) =>
      openReport(report, {
        intent: direction.length > 0 ? `${IMPLEMENT_INTENT}\n\n${direction}` : IMPLEMENT_INTENT,
      }),
    onAnswer: (answer) => openReport(report, { intent: answer }),
    onAsk: () => openReport(report),
    onContinue: () => openReport(report),
    // Reviewing happens in the app when the repository is one this
    // environment has: the diff, the checks, and the approve control are all
    // already here. Only an unrecognised repository falls out to the host.
    onReviewPullRequest: () => {
      if (pullRequestRef !== null) {
        setReviewOpen(true);
        return;
      }
      const url = report.implementation_pr_url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    onOpenPullRequestExternally: () => {
      const url = report.implementation_pr_url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    onArchive: () => {
      void setReportState({
        environmentId,
        input: { reportId: report.id, state: "suppressed" },
      });
      void navigate({ to: "/inbox" });
    },
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ReportPageHeader>
        <div className="ms-auto flex items-center gap-1">
          {conversations.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => openReport(report)}>
              <MessagesSquareIcon className="size-3.5" />
              {conversations.length > 1 ? conversations.length : null} Conversation
              {conversations.length > 1 ? "s" : ""}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            render={<a href={reportUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon className="size-3.5" />
            PostHog
          </Button>
        </div>
      </ReportPageHeader>

      {openError ? (
        <p className="border-b border-border/50 px-4 py-2 text-xs text-destructive">{openError}</p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[46rem] px-6 py-6">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              {humanizeReportTitle(report.title)}
            </h1>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {report.priority ? (
                <PriorityExplanation explanation={view.priority?.explanation ?? null}>
                  <PriorityChip priority={report.priority} className="cursor-help" />
                </PriorityExplanation>
              ) : null}
              {report.source_products.map((product) => (
                <span key={product}>{sourceProductLabel(product)}</span>
              ))}
              {report.signal_count ? (
                <span className="tabular-nums">
                  {report.signal_count} signal{report.signal_count === 1 ? "" : "s"}
                </span>
              ) : null}
              {view.repoSelection?.repository ? (
                <span className="font-mono">{view.repoSelection.repository}</span>
              ) : null}
              <span className="tabular-nums">{formatRelativeTimeLabel(report.updated_at)}</span>
            </div>

            <ReportDecision
              controls={decisionControls}
              report={report}
              hasExistingPr={hasExistingPr}
              reasoning={view.actionability?.explanation ?? null}
              repository={view.repoSelection?.repository ?? null}
              className="mt-5"
              handlers={handlers}
            />

            <div className="mt-6">
              <ReportDocument
                report={report}
                artefacts={artefacts}
                signals={signalsQuery.data?.signals ?? []}
                signalsPending={signalsQuery.isPending}
                environmentId={environmentId}
              />
            </div>
          </div>
        </div>

        {reviewOpen && pullRequestRef !== null ? (
          <PreviewPanelShell
            mode="inline"
            widthStorageKey="report-review-panel-width"
            defaultWidth={620}
          >
            <div className="flex h-full min-w-0 flex-col">
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-2 ps-3">
                <span className="text-xs font-medium">Changes</span>
                <Button
                  size="icon-micro"
                  variant="ghost"
                  aria-label="Close the changes panel"
                  onClick={() => setReviewOpen(false)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <PullRequestDetailPanel
                  environmentId={environmentId}
                  reference={pullRequestRef}
                  context="page"
                  onClose={() => setReviewOpen(false)}
                />
              </div>
            </div>
          </PreviewPanelShell>
        ) : null}
      </div>
    </SidebarInset>
  );
}

/**
 * `u` goes back to the inbox, the way it does in a mail client, and `r` puts
 * the caret in the reply field on the reports that have one. Neither fires
 * while the reader is typing: inside a field, both are letters.
 *
 * The field is reached by a key rather than by autofocus so that arriving at a
 * report leaves the keyboard where the reader can still use it.
 */
function useReportPageShortcuts(controls: RefObject<ReportDecisionControls | null>): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "u" && event.key !== "r") return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
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
      if (event.key === "r") {
        if (controls.current?.focusInput() === true) event.preventDefault();
        return;
      }
      event.preventDefault();
      void navigate({ to: "/inbox" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controls, navigate]);
}
