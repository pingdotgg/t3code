import { createFileRoute } from "@tanstack/react-router";

import { ReportDetailPage } from "../components/reports/ReportDetailPage";

export const Route = createFileRoute("/_chat/inbox_/$reportId")({
  component: function ReportRoute() {
    const { reportId } = Route.useParams();
    return <ReportDetailPage reportId={reportId} />;
  },
});
