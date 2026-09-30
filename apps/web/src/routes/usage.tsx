import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import type { UsageMetric } from "../components/usage/usageShortcuts";

export interface UsageSearch {
  readonly metric?: UsageMetric;
}

export const Route = createFileRoute("/usage")({
  validateSearch: (raw: Record<string, unknown>): UsageSearch =>
    raw.metric === "cost" || raw.metric === "limits" || raw.metric === "tokens"
      ? { metric: raw.metric }
      : {},
  component: UsageRoute,
});

function UsageRoute() {
  const { metric } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onMetricChange = (nextMetric: UsageMetric) => {
    void navigate({
      search: { metric: nextMetric },
      replace: true,
    });
  };
  return <UsagePage metric={metric} onMetricChange={onMetricChange} />;
}
