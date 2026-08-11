import { ProviderInstanceId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { UsagePage } from "../components/usage/UsagePage";

export interface UsageSearch {
  readonly provider?: ProviderInstanceId;
}

export function parseUsageSearch(raw: Record<string, unknown>): UsageSearch {
  if (typeof raw.provider !== "string") return {};
  const provider = raw.provider.trim();
  return Schema.is(ProviderInstanceId)(provider) ? { provider } : {};
}

export const Route = createFileRoute("/usage")({
  component: UsagePage,
  validateSearch: parseUsageSearch,
});
