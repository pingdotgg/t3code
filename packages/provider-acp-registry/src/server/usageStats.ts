import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

/**
 * Maps an agent's `account/usage_stats` response into `ServerProviderUsageLimits`;
 * `undefined` when nothing is usable. Known sections: `zcode` (Start Plan
 * one_time grants — `resetsAt` is the grant expiry, not a refill) and `glm`
 * (Coding Plan windows). Other sections are ignored.
 */

interface ZcodeStatsSection {
  readonly kind?: unknown;
  readonly windows?: unknown;
}

interface GlmStatsSection {
  readonly kind?: unknown;
  readonly items?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asStringArray = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => asString(item) !== null).map((item) => item.trim())
    : undefined;

/** Epoch milliseconds → ISO string; invalid values drop the field. */
const isoFromEpochMs = (value: unknown): string | undefined => {
  const ms = asFiniteNumber(value);
  if (ms === null || ms <= 0) return undefined;
  const dt = DateTime.make(ms);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
};

/** Start-plan grants have irregular windows; GLM labels map onto known kinds. */
const kindForLabel = (label: string | null): ServerProviderUsageWindow["kind"] => {
  const normalized = label?.toLowerCase() ?? "";
  if (normalized === "5h" || normalized === "session") return "session";
  if (normalized === "week" || normalized === "weekly") return "weekly";
  if (normalized === "month" || normalized === "monthly") return "monthly";
  return "other";
};

function zcodeWindows(section: ZcodeStatsSection): ReadonlyArray<ServerProviderUsageWindow> {
  if (section.kind !== "success" || !Array.isArray(section.windows)) return [];
  return section.windows.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const key = asString(entry.key);
    const label = asString(entry.label);
    const usedPercent = asFiniteNumber(entry.usagePercent);
    if (key === null || usedPercent === null) return [];
    const modelIds = asStringArray(entry.modelIds);
    return [
      {
        id: `zcode:${key}`,
        kind: "other" as const,
        label: label ?? key,
        ...(modelIds !== undefined && modelIds.length > 0 ? { modelIds } : {}),
        usedPercent: clampPercent(usedPercent),
        ...(isoFromEpochMs(entry.resetsAt) !== undefined
          ? { resetsAt: isoFromEpochMs(entry.resetsAt) }
          : {}),
      } satisfies ServerProviderUsageWindow,
    ];
  });
}

function glmWindows(section: GlmStatsSection): ReadonlyArray<ServerProviderUsageWindow> {
  if (section.kind !== "success" || !Array.isArray(section.items)) return [];
  return section.items.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const key = asString(entry.key);
    const label = asString(entry.label);
    const usedPercent = asFiniteNumber(entry.usedPercent);
    if (key === null || usedPercent === null) return [];
    const resolvedLabel = label ?? key;
    const modelIds = asStringArray(entry.modelIds);
    return [
      {
        id: `glm:${key}`,
        kind: kindForLabel(label),
        label: resolvedLabel,
        ...(modelIds !== undefined && modelIds.length > 0 ? { modelIds } : {}),
        usedPercent: clampPercent(usedPercent),
        ...(isoFromEpochMs(entry.nextResetTime) !== undefined
          ? { resetsAt: isoFromEpochMs(entry.nextResetTime) }
          : {}),
      } satisfies ServerProviderUsageWindow,
    ];
  });
}

/** Map an `account/usage_stats` payload; `undefined` when nothing is usable. */
export function usageStatsToUsageLimits(
  payload: unknown,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  if (!isRecord(payload)) return undefined;
  const windows = [
    ...zcodeWindows(isRecord(payload.zcode) ? payload.zcode : {}),
    ...glmWindows(isRecord(payload.glm) ? payload.glm : {}),
  ];
  if (windows.length === 0) return undefined;
  return makeUsageLimits({ checkedAt, windows });
}
