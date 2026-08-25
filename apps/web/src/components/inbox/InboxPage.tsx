/**
 * The report inbox. One full-width list, read top to bottom: open a report,
 * act on it, move to the next one. Archiving and restoring write straight
 * through to PostHog; read state is local to this client.
 */
import type { EnvironmentId, PostHogReport } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveRestoreIcon, ArchiveXIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../../brand/EmptyState";
import { statusColorVar } from "../../brand/statusColors";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { selectReportSeenMap, useReportSeenStore } from "../../reportSeenStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { postHogEnvironment, reportsListAtom } from "../../state/posthog";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PriorityChip } from "../reports/PriorityChip";
import { usePostHogQuery, type PostHogQueryError } from "../reports/reportsQuery";
import { useReportOpener } from "../reports/useOpenReport";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  doneReports,
  groupInboxReports,
  isReportUnread,
  nextFocusedReportId,
  reportStateLabel,
  summaryLine,
} from "./inboxList.logic";

export type InboxView = "inbox" | "done";

const VIEW_TITLES: Readonly<Record<InboxView, string>> = {
  inbox: "Inbox",
  done: "Done",
};

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

function ReportRow({
  report,
  unread,
  focused,
  busy,
  view,
  onOpen,
  onArchive,
  onRestore,
  onFocus,
}: {
  readonly report: PostHogReport;
  readonly unread: boolean;
  readonly focused: boolean;
  readonly busy: boolean;
  readonly view: InboxView;
  readonly onOpen: () => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  readonly onFocus: () => void;
}) {
  const summary = summaryLine(report.summary);
  return (
    <div
      data-report-row={report.id}
      data-focused={focused ? "" : undefined}
      className={cn(
        "group flex w-full items-center gap-3 border-b border-border/50 px-4 py-2.5 text-sm",
        focused ? "bg-accent/60" : "hover:bg-accent/30",
      )}
      onMouseEnter={onFocus}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={unread ? { backgroundColor: statusColorVar("needsYou") } : undefined}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-baseline gap-2 text-left outline-hidden"
        onClick={onOpen}
      >
        <span className={cn("shrink-0 truncate", unread ? "font-semibold" : "font-normal")}>
          {report.title}
        </span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        ) : null}
      </button>
      {report.priority ? <PriorityChip priority={report.priority} className="shrink-0" /> : null}
      <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
        {reportStateLabel(report.status)}
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatRelativeTimeLabel(report.updated_at)}
      </span>
      <Button
        size="icon-micro"
        variant="ghost"
        className="shrink-0"
        disabled={busy}
        aria-label={view === "done" ? `Restore ${report.title}` : `Archive ${report.title}`}
        onClick={view === "done" ? onRestore : onArchive}
      >
        {view === "done" ? (
          <ArchiveRestoreIcon className="size-3.5" />
        ) : (
          <ArchiveXIcon className="size-3.5" />
        )}
      </Button>
    </div>
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
  const seen = useReportSeenStore(selectReportSeenMap);
  const setReportState = useAtomCommand(postHogEnvironment.setReportState, {
    reportFailure: false,
  });
  const { openReport, error: openError } = useReportOpener(environmentId);
  // Archiving is written to PostHog and confirmed by the next list fetch; the
  // row leaves the list immediately so the reader keeps moving.
  const [statusOverrides, setStatusOverrides] = useState<Readonly<Record<string, string>>>({});
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [focusedReportId, setFocusedReportId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reports = useMemo(() => {
    const fetched = reportsQuery.data?.reports ?? [];
    return fetched.map((report) => {
      const override = statusOverrides[report.id];
      return override === undefined || override === report.status
        ? report
        : { ...report, status: override };
    });
  }, [reportsQuery.data, statusOverrides]);

  const sections = useMemo(
    () =>
      view === "done"
        ? [{ id: "done" as const, label: "Done", reports: doneReports(reports) }]
        : groupInboxReports(reports),
    [reports, view],
  );
  const orderedIds = useMemo<ReadonlyArray<string>>(
    () => sections.flatMap((section) => section.reports.map((report) => String(report.id))),
    [sections],
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
    if (focusedReportId === null) return;
    listRef.current
      ?.querySelector(`[data-report-row="${CSS.escape(focusedReportId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedReportId]);

  const changeState = useCallback(
    async (report: PostHogReport, state: "suppressed" | "potential") => {
      if (busyReportId !== null) return;
      setBusyReportId(report.id);
      setActionError(null);
      setFocusedReportId(nextFocusedReportId(orderedIds, report.id));
      setStatusOverrides((current) => ({ ...current, [report.id]: state }));
      const result = await setReportState({
        environmentId,
        input: { reportId: report.id, state },
      });
      setBusyReportId(null);
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
        return;
      }
      reportsQuery.refresh();
    },
    [busyReportId, environmentId, orderedIds, reportsQuery, setReportState],
  );

  const focusedReport = useMemo(
    () => reports.find((report) => report.id === focusedReportId) ?? null,
    [focusedReportId, reports],
  );

  useEffect(() => {
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
        openReport(focusedReport);
        return;
      }
      void changeState(focusedReport, view === "done" ? "potential" : "suppressed");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeState, focusedReport, openReport, orderedIds, view]);

  const total = orderedIds.length;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
        <h1 className="text-sm font-semibold">{VIEW_TITLES[view]}</h1>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          disabled={reportsQuery.isPending}
          onClick={reportsQuery.refresh}
        >
          {reportsQuery.isPending ? "Loading…" : "Refresh"}
        </Button>
      </WorkspacePageHeader>
      {(actionError ?? openError) ? (
        <p className="border-b border-border/50 px-4 py-2 text-xs text-destructive">
          {actionError ?? openError}
        </p>
      ) : null}
      {reportsQuery.error ? (
        <PostHogErrorState error={reportsQuery.error} />
      ) : total === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          {reportsQuery.isPending ? (
            <EmptyState hoggie="loading" title="Loading reports" />
          ) : view === "done" ? (
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
          {sections.map((section) => (
            <section key={section.id}>
              <h2 className="sticky top-0 z-10 border-b border-border/50 bg-background/95 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {section.label}
              </h2>
              {section.reports.map((report) => (
                <ReportRow
                  key={report.id}
                  report={report}
                  view={view}
                  unread={isReportUnread(report, seen)}
                  focused={focusedReportId === report.id}
                  busy={busyReportId === report.id}
                  onFocus={() => setFocusedReportId(report.id)}
                  onOpen={() => openReport(report)}
                  onArchive={() => void changeState(report, "suppressed")}
                  onRestore={() => void changeState(report, "potential")}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </SidebarInset>
  );
}
