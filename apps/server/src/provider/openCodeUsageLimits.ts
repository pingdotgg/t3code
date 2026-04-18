import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

import type { OpenCodeInventory } from "./opencodeRuntime.ts";
import { getOpenCodeManagedProviderDescriptor } from "./opencodeRuntime.ts";
import { clampPercent } from "./providerUsageLimits.ts";

type ManagedProviderRecord = OpenCodeInventory["providerList"]["all"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const date = new Date(trimmed);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function toUsageWindow(
  usage: Record<string, unknown>,
  label: string,
): ServerProviderUsageWindow | undefined {
  const resetsAt =
    readIsoDateTime(usage.resetsAt) ??
    readIsoDateTime(usage.resetAt) ??
    readIsoDateTime(usage.renewsAt);
  const explicitPercent =
    readFiniteNumber(usage.usedPercent) ??
    readFiniteNumber(usage.usagePercent) ??
    readFiniteNumber(usage.percentUsed) ??
    readFiniteNumber(usage.percentage);

  const computedPercent =
    explicitPercent ??
    (() => {
      const used = readFiniteNumber(usage.used);
      const limit =
        readFiniteNumber(usage.limit) ??
        readFiniteNumber(usage.max) ??
        readFiniteNumber(usage.total);
      if (used === undefined || limit === undefined || limit <= 0) {
        return undefined;
      }
      return (used / limit) * 100;
    })();

  if (computedPercent === undefined || !Number.isFinite(computedPercent)) {
    return undefined;
  }

  return {
    kind: "session",
    label,
    usedPercent: clampPercent(computedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function extractUsageWindow(
  provider: ManagedProviderRecord,
): ServerProviderUsageWindow | undefined {
  const descriptor = getOpenCodeManagedProviderDescriptor(provider.id);
  if (!descriptor) {
    return undefined;
  }

  const providerRecord = provider as unknown as Record<string, unknown>;
  const providerOptions = isRecord(providerRecord.options) ? providerRecord.options : undefined;
  const providerMetadata = isRecord(providerRecord.metadata) ? providerRecord.metadata : undefined;
  const candidates = [
    providerRecord.usage,
    providerRecord.quota,
    providerRecord.subscriptionUsage,
    providerRecord.usageLimits,
    providerOptions?.usage,
    providerOptions?.quota,
    providerOptions?.subscriptionUsage,
    providerOptions?.usageLimits,
    providerMetadata?.usage,
    providerMetadata?.quota,
  ];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const window = toUsageWindow(candidate, descriptor.label);
    if (window) {
      return window;
    }
  }

  return undefined;
}

export function resolveOpenCodeManagedUsageLimits(input: {
  readonly checkedAt: string;
  readonly inventory: OpenCodeInventory;
}): ServerProviderUsageLimits | undefined {
  const connected = new Set(input.inventory.providerList.connected);
  const windows = input.inventory.providerList.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => {
      if (!getOpenCodeManagedProviderDescriptor(provider.id)) {
        return [];
      }
      const window = extractUsageWindow(provider);
      return window ? [window] : [];
    });

  if (windows.length === 0) {
    return undefined;
  }

  return {
    source: "opencodeManaged",
    available: true,
    checkedAt: input.checkedAt,
    windows,
  };
}
