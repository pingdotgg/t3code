/**
 * PostHog reports inbox: the list on the left, one report's detail on the
 * right. Reads through the primary server, which holds the PostHog key.
 */
import type { PostHogReport } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { reportsListAtom } from "../../state/posthog";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ReportDetailPanel } from "./ReportDetailPanel";
import { usePostHogQuery, type PostHogQueryError } from "./reportsQuery";

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ReportsErrorState({ error }: { readonly error: PostHogQueryError }) {
  const navigate = useNavigate();
  const title =
    error.tag === "not-configured"
      ? "PostHog not configured"
      : error.tag === "unauthorized"
        ? "PostHog rejected the API key"
        : "PostHog request failed";
  return (
    <div className="flex flex-col items-start gap-2 p-5 text-sm">
      <p className="font-medium">{title}</p>
      {error.tag === "other" ? <p className="text-muted-foreground">{error.message}</p> : null}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void navigate({ to: "/settings/integrations" })}
      >
        Open PostHog settings
      </Button>
    </div>
  );
}

function ReportRow({
  report,
  selected,
  onSelect,
}: {
  readonly report: PostHogReport;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left hover:bg-muted/60 ${selected ? "bg-muted" : ""}`}
      >
        <span className="truncate text-sm font-medium">{report.title}</span>
        <span className="text-xs text-muted-foreground">
          {report.status}
          {report.priority ? ` · ${report.priority}` : ""}
          {` · ${formatUpdatedAt(report.updated_at)}`}
        </span>
      </button>
    </li>
  );
}

export function ReportsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <p className="p-5 text-sm text-muted-foreground">Connect a server to see reports.</p>
      </SidebarInset>
    );
  }
  return <ConnectedReportsPage environmentId={environmentId} />;
}

function ConnectedReportsPage({
  environmentId,
}: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
}) {
  const navigate = useNavigate();
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const selectedReportId = useSearch({ from: "/_chat/reports", select: (s) => s.reportId });
  const reports = reportsQuery.data?.reports ?? [];
  const selectedReport =
    reports.find((report) => report.id === selectedReportId) ?? reports[0] ?? null;
  const selectReport = (reportId: string) =>
    void navigate({ to: "/reports", search: { reportId }, replace: true });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
        <h1 className="text-sm font-semibold">Reports</h1>
        <Button
          size="sm"
          variant="ghost"
          disabled={reportsQuery.isPending}
          onClick={reportsQuery.refresh}
        >
          {reportsQuery.isPending ? "Loading…" : "Refresh"}
        </Button>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border/60">
          {reportsQuery.error ? <ReportsErrorState error={reportsQuery.error} /> : null}
          {!reportsQuery.error && reports.length === 0 && !reportsQuery.isPending ? (
            <p className="p-5 text-sm text-muted-foreground">No reports.</p>
          ) : null}
          <ul className="divide-y divide-border/40">
            {reports.map((report) => (
              <ReportRow
                key={report.id}
                report={report}
                selected={selectedReport?.id === report.id}
                onSelect={() => selectReport(report.id)}
              />
            ))}
          </ul>
        </div>
        {selectedReport ? (
          <ReportDetailPanel
            key={selectedReport.id}
            environmentId={environmentId}
            report={selectedReport}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a report.
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
