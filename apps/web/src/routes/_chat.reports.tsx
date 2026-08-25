import { createFileRoute } from "@tanstack/react-router";

import { ReportsPage } from "../components/reports/ReportsPage";

export const Route = createFileRoute("/_chat/reports")({
  component: ReportsPage,
});
