import { createFileRoute } from "@tanstack/react-router";

import { UsagePage, type UsageMetric } from "../components/usage/UsagePage";

export interface UsageSearch {
  readonly metric?: "limits" | "tokens";
}

export const Route = createFileRoute("/usage")({
  validateSearch: (raw: Record<string, unknown>): UsageSearch =>
    raw.metric === "limits" || raw.metric === "tokens" ? { metric: raw.metric } : {},
  component: UsageRoute,
});

function UsageRoute() {
  const { metric } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onMetricChange = (nextMetric: UsageMetric) => {
    void navigate({
      search: nextMetric === "cost" ? {} : { metric: nextMetric },
      replace: true,
    });
  };
  return <UsagePage metric={metric ?? "cost"} onMetricChange={onMetricChange} />;
}
