/**
 * One PostHog report, chosen from the sidebar. Reads through the primary
 * server, which holds the PostHog key.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { reportsListAtom } from "../../state/posthog";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ReportDetailPanel } from "./ReportDetailPanel";
import { usePostHogQuery, type PostHogQueryError } from "./reportsQuery";

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
        {reportsQuery.error ? (
          <ReportsErrorState error={reportsQuery.error} />
        ) : selectedReport ? (
          <ReportDetailPanel
            key={selectedReport.id}
            environmentId={environmentId}
            report={selectedReport}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {reportsQuery.isPending
              ? "Loading reports…"
              : "No reports yet. Pick one from the sidebar when they arrive."}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
