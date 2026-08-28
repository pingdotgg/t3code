/**
 * Pure parsing for Claude subscription limits.
 *
 * The Claude CLI stores its OAuth grant either in `.credentials.json` under
 * the Claude home or in the macOS login keychain; the usage figures come from
 * Anthropic's OAuth usage endpoint. Neither shape is a published contract, so
 * both parsers are defensive: an unrecognised document yields `null`/empty
 * rather than an error, and unknown window ids still render with a humanised
 * label instead of being dropped.
 *
 * @module usageLimitsClaude
 */
import type { UsageLimitWindow } from "@t3tools/contracts";

export interface ClaudeOauthCredentials {
  readonly accessToken: string;
  /** Raw plan marker from the credential store, e.g. `max`. */
  readonly subscriptionType: string | null;
}

/**
 * Reads the CLI's credential document (file contents or keychain payload).
 * Only OAuth grants qualify: an API key never produces this shape, which is
 * exactly the signal that limits do not apply.
 */
export function parseClaudeOauthCredentials(raw: string): ClaudeOauthCredentials | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const oauth = (document as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return null;
  const { accessToken, subscriptionType } = oauth as Record<string, unknown>;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;
  return {
    accessToken: accessToken.trim(),
    subscriptionType:
      typeof subscriptionType === "string" && subscriptionType.trim().length > 0
        ? subscriptionType.trim()
        : null,
  };
}

/** The signed-in account's email, from the OAuth profile endpoint. */
export function parseClaudeProfileEmail(document: unknown): string | null {
  if (typeof document !== "object" || document === null) return null;
  const account = (document as Record<string, unknown>).account;
  if (typeof account !== "object" || account === null) return null;
  const email = (account as Record<string, unknown>).email;
  return typeof email === "string" && email.trim().length > 0 ? email.trim() : null;
}

const PLAN_LABELS: Record<string, string> = {
  free: "Claude Free",
  pro: "Claude Pro",
  max: "Claude Max",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
};

export function claudePlanLabel(subscriptionType: string | null): string | null {
  if (subscriptionType === null) return null;
  const normalized = subscriptionType.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return (
    PLAN_LABELS[normalized] ?? `Claude ${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
  );
}

/**
 * Legacy top-level windows, kept as a fallback for responses without the
 * structured `limits` array. Only these ids qualify: the response also
 * carries codenamed experiment slots (`nimbus_quill`, `tangelo`, ...) in the
 * same shape, and those are provider-internal, not user-meaningful windows.
 */
const LEGACY_WINDOWS: readonly { id: string; label: string; detail: string }[] = [
  { id: "five_hour", label: "Session limit", detail: "Rolling 5-hour window" },
  { id: "seven_day", label: "Weekly limit", detail: "All models · rolling 7-day window" },
  { id: "seven_day_opus", label: "Weekly limit (Opus)", detail: "Rolling 7-day window" },
  { id: "seven_day_sonnet", label: "Weekly limit (Sonnet)", detail: "Rolling 7-day window" },
];

/** `weekly_all` → "Weekly all". */
function humanizeId(id: string): string {
  const words = id.replaceAll(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * Percent consumed. Clamped, not rounded: the provider may legitimately sit
 * fractionally above 100 at the edge of a window.
 */
function clampUtilization(value: number): number {
  return Math.min(Math.max(value, 0), 999);
}

function readInstant(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The model display name on a `weekly_scoped` limit entry, e.g. "Fable". */
function readScopedModelName(scope: unknown): string | null {
  if (typeof scope !== "object" || scope === null) return null;
  const model = (scope as Record<string, unknown>).model;
  if (typeof model !== "object" || model === null) return null;
  const name = (model as Record<string, unknown>).display_name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

function labelForLimitKind(
  kind: string,
  scopeName: string | null,
): { label: string; detail: string | null } {
  switch (kind) {
    case "session":
      return { label: "Session limit", detail: "Rolling 5-hour window" };
    case "weekly_all":
      return { label: "Weekly limit", detail: "All models · rolling 7-day window" };
    case "weekly_scoped":
      return {
        label: scopeName === null ? "Weekly limit (scoped)" : `Weekly limit (${scopeName})`,
        detail: "Rolling 7-day window",
      };
    default:
      return {
        label: scopeName === null ? humanizeId(kind) : `${humanizeId(kind)} (${scopeName})`,
        detail: null,
      };
  }
}

/**
 * The extra-usage credit budget, rendered as a window when the account has
 * one. It is spend, not a rate window, so the caption carries the money
 * figures instead of a reset cadence.
 */
function parseExtraUsage(value: unknown): UsageLimitWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const { utilization, used_credits, monthly_limit, currency, decimal_places, is_enabled } =
    value as Record<string, unknown>;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  if (utilization <= 0 && is_enabled !== true) return null;

  let detail: string | null = null;
  if (
    typeof used_credits === "number" &&
    typeof monthly_limit === "number" &&
    typeof decimal_places === "number" &&
    Number.isInteger(decimal_places) &&
    decimal_places >= 0 &&
    decimal_places <= 4
  ) {
    const scale = 10 ** decimal_places;
    const format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: typeof currency === "string" && currency.length === 3 ? currency : "USD",
    });
    detail = `${format.format(used_credits / scale)} of ${format.format(monthly_limit / scale)} monthly usage credits`;
  }

  return {
    id: "extra_usage",
    label: "Extra usage credits",
    detail,
    utilization: clampUtilization(utilization),
    resetsAt: null,
  };
}

/**
 * Extracts rate windows from the OAuth usage response.
 *
 * The structured `limits` array is authoritative when present: it is the only
 * place model-scoped weekly windows (e.g. Fable) appear, and its entries are
 * curated rather than experiment slots. Responses without it fall back to the
 * known legacy top-level keys. The extra-usage credit budget is appended
 * either way.
 */
export function parseClaudeUsageWindows(document: unknown): UsageLimitWindow[] {
  if (typeof document !== "object" || document === null) return [];
  const record = document as Record<string, unknown>;

  const windows: UsageLimitWindow[] = [];

  if (Array.isArray(record.limits)) {
    for (const entry of record.limits) {
      if (typeof entry !== "object" || entry === null) continue;
      const { kind, percent, resets_at, scope } = entry as Record<string, unknown>;
      if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
      const kindId = typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : "unknown";
      const scopeName = readScopedModelName(scope);
      windows.push({
        id: scopeName === null ? kindId : `${kindId}:${scopeName}`,
        ...labelForLimitKind(kindId, scopeName),
        utilization: clampUtilization(percent),
        resetsAt: readInstant(resets_at),
      });
    }
  }

  if (windows.length === 0) {
    for (const { id, label, detail } of LEGACY_WINDOWS) {
      const value = record[id];
      if (typeof value !== "object" || value === null) continue;
      const { utilization, resets_at } = value as Record<string, unknown>;
      if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
      windows.push({
        id,
        label,
        detail,
        utilization: clampUtilization(utilization),
        resetsAt: readInstant(resets_at),
      });
    }
  }

  const extraUsage = parseExtraUsage(record.extra_usage);
  if (extraUsage !== null) windows.push(extraUsage);
  return windows;
}
