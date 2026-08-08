/**
 * Defensive mapping for Claude Code's experimental `get_usage` response.
 *
 * The SDK explicitly marks this response as unstable. Decode only the small
 * provider-neutral subset the clients render and ignore every unknown field,
 * so a Claude Code update can add or reshape analytics without taking the
 * provider status snapshot down with it.
 */
import type {
  ProviderAccountNamedRateLimitWindow,
  ProviderAccountRateLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NullableNumber = Schema.NullOr(Schema.Number);
const NullableString = Schema.NullOr(Schema.String);

const ClaudeUsageLimit = Schema.Struct({
  kind: Schema.optional(Schema.String),
  percent: Schema.optional(NullableNumber),
  utilization: Schema.optional(NullableNumber),
  resets_at: Schema.optional(NullableString),
  severity: Schema.optional(Schema.String),
  is_active: Schema.optional(Schema.Boolean),
  display_name: Schema.optional(Schema.String),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              display_name: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});

const ClaudeExtraUsage = Schema.Struct({
  is_enabled: Schema.optional(Schema.Boolean),
  utilization: Schema.optional(NullableNumber),
  used_credits: Schema.optional(NullableNumber),
  monthly_limit: Schema.optional(NullableNumber),
  currency: Schema.optional(NullableString),
});

const ClaudeRateLimits = Schema.Struct({
  limits: Schema.optional(Schema.Array(ClaudeUsageLimit)),
  model_scoped: Schema.optional(Schema.Array(ClaudeUsageLimit)),
  five_hour: Schema.optional(Schema.NullOr(ClaudeUsageLimit)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeUsageLimit)),
  seven_day_opus: Schema.optional(Schema.NullOr(ClaudeUsageLimit)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(ClaudeUsageLimit)),
  seven_day_oauth_apps: Schema.optional(Schema.NullOr(ClaudeUsageLimit)),
  extra_usage: Schema.optional(Schema.NullOr(ClaudeExtraUsage)),
});

const ClaudeUsageResponse = Schema.Struct({
  subscription_type: Schema.optional(NullableString),
  rate_limits_available: Schema.optional(Schema.Boolean),
  rate_limits: Schema.optional(Schema.NullOr(ClaudeRateLimits)),
});
const decodeClaudeUsageResponse = Schema.decodeUnknownOption(ClaudeUsageResponse);

type ClaudeUsageLimitValue = typeof ClaudeUsageLimit.Type;

export interface ClaudeAccountQuota {
  readonly subscriptionType?: string;
  readonly rateLimits?: ProviderAccountRateLimits;
}

function trimmed(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

function clampPercent(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

function normalizeReset(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );
}

function humanize(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Limit";
}

function preferredLabel(kind: string, modelName: string | undefined): string {
  switch (kind) {
    case "session":
      return "Session";
    case "weekly_all":
      return "Week · all models";
    case "weekly_scoped":
      return `Week · ${modelName ?? "model"}`;
    default:
      return humanize(kind);
  }
}

function mapWindow(input: {
  readonly id: string;
  readonly label: string;
  readonly limit: ClaudeUsageLimitValue;
  readonly preferPercent?: boolean;
}): ProviderAccountNamedRateLimitWindow | undefined {
  const usedPercent = clampPercent(
    input.preferPercent ? input.limit.percent : input.limit.utilization,
  );
  if (usedPercent === undefined) return undefined;
  const resetsAt = normalizeReset(input.limit.resets_at);
  const severity = trimmed(input.limit.severity);
  return {
    id: input.id,
    label: input.label,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(severity ? { severity } : {}),
    ...(input.limit.is_active !== undefined ? { isActive: input.limit.is_active } : {}),
  };
}

function dedupeWindows(
  windows: NonNullable<ProviderAccountRateLimits["windows"]>,
): NonNullable<ProviderAccountRateLimits["windows"]> {
  const ids = new Set<string>();
  return windows.filter((window) => {
    if (ids.has(window.id)) return false;
    ids.add(window.id);
    return true;
  });
}

function preferredWindows(
  entries: ReadonlyArray<ClaudeUsageLimitValue>,
): NonNullable<ProviderAccountRateLimits["windows"]> {
  return dedupeWindows(
    entries.flatMap((limit) => {
      const kind = trimmed(limit.kind) ?? "limit";
      const modelName = trimmed(limit.scope?.model?.display_name);
      const window = mapWindow({
        id: `${kind}${modelName ? `:${modelName}` : ""}`,
        label: preferredLabel(kind, modelName),
        limit,
        preferPercent: true,
      });
      return window ? [window] : [];
    }),
  );
}

const FALLBACK_WINDOWS = [
  ["five_hour", "Session"],
  ["seven_day", "Week · all models"],
  ["seven_day_opus", "Week · Opus"],
  ["seven_day_sonnet", "Week · Sonnet"],
  ["seven_day_oauth_apps", "Week · OAuth apps"],
] as const;

function fallbackWindows(
  rateLimits: typeof ClaudeRateLimits.Type,
): NonNullable<ProviderAccountRateLimits["windows"]> {
  const windows = FALLBACK_WINDOWS.flatMap(([id, label]) => {
    const limit = rateLimits[id];
    if (!limit) return [];
    const window = mapWindow({ id, label, limit });
    return window ? [window] : [];
  });

  for (const limit of rateLimits.model_scoped ?? []) {
    const modelName = trimmed(limit.display_name) ?? "model";
    const window = mapWindow({
      id: `weekly_scoped:${modelName}`,
      label: `Week · ${modelName}`,
      limit,
    });
    if (window) windows.push(window);
  }
  return dedupeWindows(windows);
}

/** Maps a runtime SDK response without trusting its experimental wire shape. */
export function mapClaudeAccountQuota(value: unknown, checkedAt: string): ClaudeAccountQuota {
  const decoded = decodeClaudeUsageResponse(value);
  if (Option.isNone(decoded)) return {};

  const usage = decoded.value;
  const subscriptionType = trimmed(usage.subscription_type);
  if (usage.rate_limits_available === false || !usage.rate_limits) {
    return subscriptionType ? { subscriptionType } : {};
  }

  const providerWindows = preferredWindows(usage.rate_limits.limits ?? []);
  const windows = providerWindows.length > 0 ? providerWindows : fallbackWindows(usage.rate_limits);
  const extra = usage.rate_limits.extra_usage;
  const extraUsedPercent = clampPercent(extra?.utilization);
  const usedCredits = extra?.used_credits ?? undefined;
  const monthlyLimit = extra?.monthly_limit ?? undefined;
  const currency = trimmed(extra?.currency);
  const extraUsage =
    extra?.is_enabled === true
      ? {
          isEnabled: true,
          ...(extraUsedPercent !== undefined ? { usedPercent: extraUsedPercent } : {}),
          ...(usedCredits !== undefined ? { usedCredits } : {}),
          ...(monthlyLimit !== undefined ? { monthlyLimit } : {}),
          ...(currency ? { currency } : {}),
        }
      : undefined;

  const rateLimits =
    windows.length > 0 || extraUsage
      ? {
          checkedAt,
          ...(windows.length > 0 ? { windows } : {}),
          ...(extraUsage ? { extraUsage } : {}),
        }
      : undefined;
  return {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimits ? { rateLimits } : {}),
  };
}
