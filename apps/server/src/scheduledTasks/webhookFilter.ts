import type { ScheduledTaskWebhookFilter } from "@t3tools/contracts";

import { webhookExpressionResolver, type WebhookRequest } from "./webhookTemplate.ts";

export interface FailedWebhookFilter {
  readonly index: number;
  readonly path: string;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Placeholders render null as missing, so filters treat it the same way. */
function matchesWebhookFilter(filter: ScheduledTaskWebhookFilter, value: unknown): boolean {
  if (filter.op === "exists") return value !== undefined && value !== null;
  const text = scalarText(value);
  if (text === undefined) return false;
  switch (filter.op) {
    case "equals":
      return text === filter.value;
    case "notEquals":
      return text !== filter.value;
    case "in":
      return filter.value.includes(text);
    case "startsWith":
      return text.startsWith(filter.value);
  }
}

/** The first filter the request fails, or null when every filter matches. */
export function findFailedWebhookFilter(
  filters: ReadonlyArray<ScheduledTaskWebhookFilter>,
  request: WebhookRequest,
): FailedWebhookFilter | null {
  if (filters.length === 0) return null;
  const resolve = webhookExpressionResolver(request);
  for (const [index, filter] of filters.entries()) {
    if (!matchesWebhookFilter(filter, resolve(filter.path))) return { index, path: filter.path };
  }
  return null;
}

/** Filters are numbered from 1, in the order the settings form lists them. */
export function describeFailedWebhookFilter(failed: FailedWebhookFilter): string {
  return `Filter ${failed.index + 1} (${failed.path}) did not match.`;
}
