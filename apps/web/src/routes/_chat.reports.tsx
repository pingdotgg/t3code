import { createFileRoute } from "@tanstack/react-router";

import { ReportsPage } from "../components/reports/ReportsPage";

export interface ReportsSearch {
  readonly reportId?: string;
}

export const Route = createFileRoute("/_chat/reports")({
  validateSearch: (raw: Record<string, unknown>): ReportsSearch =>
    typeof raw.reportId === "string" && raw.reportId ? { reportId: raw.reportId } : {},
  component: ReportsPage,
});
