import { ProviderInstanceId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { UsagePage } from "../components/usage/UsagePage";

export interface UsageSearch {
  readonly provider?: ProviderInstanceId;
}

const isProviderInstanceId = Schema.is(ProviderInstanceId);

export function parseUsageSearch(raw: Record<string, unknown>): UsageSearch {
  if (typeof raw.provider !== "string") return {};
  const provider = raw.provider.trim();
  return isProviderInstanceId(provider) ? { provider } : {};
}

function UsageRoutePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const handleProviderSelect = useCallback(
    (provider: ProviderInstanceId) => {
      void navigate({
        search: { provider },
        hash: "provider-limits",
        replace: true,
      });
    },
    [navigate],
  );
  return (
    <UsagePage
      onProviderSelect={handleProviderSelect}
      requestedProviderId={search.provider ?? null}
    />
  );
}

export const Route = createFileRoute("/usage")({
  component: UsageRoutePage,
  validateSearch: parseUsageSearch,
});
