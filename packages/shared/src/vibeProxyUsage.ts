/**
 * Shared presentation logic for Vibe-Proxy usage views.
 *
 * The Vibe-Proxy wire contract is deliberately permissive: `provider` is a free
 * string, quota windows may be unknown or unsupported, and a snapshot can be a
 * persisted one from an earlier visit. Everything that turns those loose values
 * into something renderable lives here so it can be tested without React.
 */
import type {
  VibeProxyQuotaWindow,
  VibeProxyRecentRequestBucket,
  VibeProxyUsageAccount,
  VibeProxyUsageRefreshProblem,
  VibeProxyUsageResult,
  VibeProxySettings,
} from "@t3tools/contracts";

export type VibeProxyProviderKind =
  | "codex"
  | "claude"
  | "antigravity"
  | "gemini"
  | "grok"
  | "unknown";

/** Cache identity for a complete, enabled Vibe-Proxy configuration. */
export function vibeProxyConfigurationKey(settings: VibeProxySettings): string | null {
  const baseUrl = settings.baseUrl.trim();
  if (
    !settings.enabled ||
    baseUrl.length === 0 ||
    (settings.apiKey.trim().length === 0 && !settings.apiKeyRedacted)
  ) {
    return null;
  }
  return `${baseUrl}:${settings.apiKeyRedacted ? "stored" : settings.apiKey.length}`;
}

/** Reading order for provider groups. Unrecognised providers sort last. */
const PROVIDER_KIND_ORDER: readonly VibeProxyProviderKind[] = [
  "codex",
  "claude",
  "antigravity",
  "gemini",
  "grok",
  "unknown",
];

const PROVIDER_KIND_LABEL: Readonly<Record<Exclude<VibeProxyProviderKind, "unknown">, string>> = {
  codex: "Codex",
  claude: "Claude",
  antigravity: "Antigravity",
  gemini: "Gemini",
  grok: "Grok",
};

/**
 * Maps a Vibe-Proxy `provider`/`type` string onto a brand we have a mark for.
 * Vibe-Proxy names the same vendor several ways depending on which credential
 * file produced the entry, so match on substrings rather than exact values.
 */
export function vibeProxyProviderKind(provider: string): VibeProxyProviderKind {
  const normalized = provider.trim().toLowerCase();
  if (normalized.length === 0) return "unknown";
  if (normalized.includes("antigravity")) return "antigravity";
  if (normalized.includes("gemini") || normalized.includes("google")) return "gemini";
  if (normalized.includes("grok") || normalized === "xai" || normalized.startsWith("xai-")) {
    return "grok";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude";
  if (
    normalized.includes("codex") ||
    normalized.includes("openai") ||
    normalized.includes("chatgpt")
  ) {
    return "codex";
  }
  return "unknown";
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** Brand name for a known provider, otherwise the raw value made presentable. */
export function vibeProxyProviderLabel(provider: string): string {
  const kind = vibeProxyProviderKind(provider);
  if (kind !== "unknown") return PROVIDER_KIND_LABEL[kind];
  const cleaned = provider.trim();
  return cleaned.length === 0 ? "Unknown provider" : titleCase(cleaned);
}

/** Two-letter mark for providers with no brand icon. */
export function vibeProxyProviderInitials(provider: string): string {
  const words = provider
    .trim()
    .split(/[\s_-]+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

/** Best human name for one credential, falling back through the identity fields. */
export function vibeProxyAccountName(account: VibeProxyUsageAccount): string {
  return (
    account.label?.trim() ||
    account.account?.trim() ||
    account.email?.trim() ||
    account.id.trim() ||
    "Account"
  );
}

/** Secondary identity line, omitted when it would repeat the primary name. */
export function vibeProxyAccountSubtitle(account: VibeProxyUsageAccount): string | null {
  const name = vibeProxyAccountName(account);
  for (const candidate of [account.email, account.account]) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed !== name) return trimmed;
  }
  return null;
}

export interface VibeProxyProviderGroup {
  readonly key: string;
  readonly provider: string;
  readonly kind: VibeProxyProviderKind;
  readonly label: string;
  readonly accounts: readonly VibeProxyUsageAccount[];
}

/**
 * Groups accounts by their raw provider string, ordered by brand and then
 * alphabetically. Two providers that map to the same brand (say `codex` and
 * `openai`) stay separate groups because they are separate upstream pools.
 */
export function groupVibeProxyAccounts(
  accounts: readonly VibeProxyUsageAccount[],
): readonly VibeProxyProviderGroup[] {
  const groups = new Map<string, VibeProxyUsageAccount[]>();
  for (const account of accounts) {
    const key = account.provider.trim().toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.push(account);
    else groups.set(key, [account]);
  }

  return [...groups.entries()]
    .map(([key, groupAccounts]) => {
      const provider = groupAccounts[0]!.provider;
      return {
        key,
        provider,
        kind: vibeProxyProviderKind(provider),
        label: vibeProxyProviderLabel(provider),
        accounts: groupAccounts,
      };
    })
    .sort((a, b) => {
      const rank = PROVIDER_KIND_ORDER.indexOf(a.kind) - PROVIDER_KIND_ORDER.indexOf(b.kind);
      return rank !== 0 ? rank : a.label.localeCompare(b.label);
    });
}

export type VibeProxyAccountTone = "ok" | "warning" | "error" | "muted";

export interface VibeProxyAccountStatus {
  readonly label: string;
  readonly tone: VibeProxyAccountTone;
  readonly detail: string | null;
}

/** Account availability, preferring the explicit flags over the free-text status. */
export function vibeProxyAccountStatus(account: VibeProxyUsageAccount): VibeProxyAccountStatus {
  const detail = account.statusMessage?.trim() || null;
  if (account.disabled) return { label: "Disabled", tone: "muted", detail };
  if (account.unavailable) return { label: "Unavailable", tone: "error", detail };

  const normalized = account.status.trim().toLowerCase();
  if (normalized === "active" || normalized === "ok" || normalized === "healthy") {
    return { label: "Active", tone: "ok", detail };
  }
  if (normalized === "unknown" || normalized.length === 0) {
    return { label: "Unknown", tone: "muted", detail };
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return { label: titleCase(account.status), tone: "error", detail };
  }
  return { label: titleCase(account.status), tone: "warning", detail };
}

export interface VibeProxyRequestHealth {
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  /** Share of successful requests in 0..1, or null when nothing has been sent. */
  readonly successRate: number | null;
  readonly tone: VibeProxyAccountTone;
}

/** Lifetime request health for one account. */
export function vibeProxyRequestHealth(account: VibeProxyUsageAccount): VibeProxyRequestHealth {
  const total = account.success + account.failed;
  const successRate = total === 0 ? null : account.success / total;
  const tone: VibeProxyAccountTone =
    successRate === null
      ? "muted"
      : successRate >= 0.98
        ? "ok"
        : successRate >= 0.85
          ? "warning"
          : "error";
  return { total, success: account.success, failed: account.failed, successRate, tone };
}

export interface VibeProxyRecentBucket extends VibeProxyRecentRequestBucket {
  /** Stable React key: bucket times can repeat across a coarse series. */
  readonly key: string;
}

export interface VibeProxyRecentActivity {
  readonly buckets: readonly VibeProxyRecentBucket[];
  readonly success: number;
  readonly failed: number;
  /** Largest bucket total, used to scale the strip. Never below 1. */
  readonly peak: number;
}

/**
 * The trailing slice of request buckets used for the activity strip. Buckets
 * arrive oldest-first and can number in the hundreds, so only the tail is kept.
 */
export function vibeProxyRecentActivity(
  account: VibeProxyUsageAccount,
  limit = 24,
): VibeProxyRecentActivity {
  const seenTimes = new Map<string, number>();
  let success = 0;
  let failed = 0;
  let peak = 0;

  const buckets = account.recentRequests.slice(-limit).map((bucket) => {
    success += bucket.success;
    failed += bucket.failed;
    peak = Math.max(peak, bucket.success + bucket.failed);
    const repeat = seenTimes.get(bucket.time) ?? 0;
    seenTimes.set(bucket.time, repeat + 1);
    return { ...bucket, key: repeat === 0 ? bucket.time : `${bucket.time}#${repeat}` };
  });

  return { buckets, success, failed, peak: Math.max(1, peak) };
}

export type VibeProxyQuotaState = "unknown" | "exhausted" | "critical" | "low" | "ok";

export interface VibeProxyQuotaWindowView {
  readonly id: string;
  readonly label: string;
  readonly state: VibeProxyQuotaState;
  /** Remaining share in 0..1, or null when the window is unknown. */
  readonly remainingFraction: number | null;
  readonly remainingPercent: number | null;
  readonly usedPercent: number | null;
  readonly resetAt: string | null;
  readonly routing: boolean;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Normalizes one quota window. Vibe-Proxy sometimes reports only `usedPercent`
 * or only `remainingPercent`, so each is derived from the other when missing,
 * and `known: false` collapses the whole window to an unknown state.
 */
export function vibeProxyQuotaWindowView(window: VibeProxyQuotaWindow): VibeProxyQuotaWindowView {
  const base = {
    id: window.id,
    label: window.label,
    resetAt: window.resetAt,
    routing: window.routing,
  };

  if (!window.known) {
    return {
      ...base,
      state: "unknown",
      remainingFraction: null,
      remainingPercent: null,
      usedPercent: null,
    };
  }

  const hasRemaining = Number.isFinite(window.remainingPercent);
  const hasUsed = Number.isFinite(window.usedPercent);
  const remainingPercent = clampPercent(
    hasRemaining ? window.remainingPercent : 100 - window.usedPercent,
  );
  const usedPercent = clampPercent(hasUsed ? window.usedPercent : 100 - window.remainingPercent);

  const state: VibeProxyQuotaState = window.hardExhausted
    ? "exhausted"
    : remainingPercent <= 0
      ? "exhausted"
      : remainingPercent < 10
        ? "critical"
        : remainingPercent < 25
          ? "low"
          : "ok";

  return {
    ...base,
    state,
    remainingFraction: remainingPercent / 100,
    remainingPercent,
    usedPercent,
  };
}

export type VibeProxyQuotaSummary =
  | { readonly kind: "windows"; readonly windows: readonly VibeProxyQuotaWindowView[] }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/** What the quota block for one account should render. */
export function vibeProxyQuotaSummary(account: VibeProxyUsageAccount): VibeProxyQuotaSummary {
  const capacity = account.quotaCapacity;
  if (capacity === null) {
    return { kind: "unavailable", message: "Vibe-Proxy has not reported quota for this account." };
  }
  if (!capacity.supported) {
    return { kind: "unsupported", message: "This provider does not report quota windows." };
  }
  if (capacity.windows.length === 0) {
    return {
      kind: "unavailable",
      message: capacity.lastError?.trim() || "No quota windows reported yet.",
    };
  }
  return { kind: "windows", windows: capacity.windows.map(vibeProxyQuotaWindowView) };
}

/** Whole percent with no trailing zeros, e.g. `82%`. */
export function formatQuotaPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

/** `99.4%`, or a dash when the account has sent nothing. */
export function formatSuccessRate(rate: number | null): string {
  if (rate === null) return "no requests";
  const percent = rate * 100;
  const decimals = percent >= 99.95 || percent === Math.round(percent) ? 0 : 1;
  return `${percent.toFixed(decimals)}%`;
}

/**
 * Countdown to a quota reset. Returns null for a missing or unparseable
 * instant so callers can omit the line entirely rather than print a placeholder.
 */
export function formatQuotaReset(resetAt: string | null, nowMs: number): string | null {
  if (resetAt === null) return null;
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(resetMs)) return null;

  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return "Reset due";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Resets in under a minute";
  if (minutes < 60) return `Resets in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes === 0
      ? `Resets in ${hours}h`
      : `Resets in ${hours}h ${remainderMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `Resets in ${days}d` : `Resets in ${days}d ${remainderHours}h`;
}

/** "Updated 4m ago" line under the accounts header. */
export function formatSnapshotAge(fetchedAt: string, nowMs: number): string | null {
  const fetchedMs = Date.parse(fetchedAt);
  if (Number.isNaN(fetchedMs)) return null;

  const diffMs = nowMs - fetchedMs;
  if (diffMs < 60_000) return "Updated just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

/** Human sentence for a failed refresh, used above stale data. */
export function describeRefreshProblem(problem: VibeProxyUsageRefreshProblem): string {
  const message = problem.message.trim();
  if (message.length > 0) return message;
  switch (problem.reason) {
    case "invalidConfiguration":
      return "The Vibe-Proxy base URL is not valid.";
    case "unauthorized":
      return "Vibe-Proxy rejected the API key.";
    case "unreachable":
      return "Vibe-Proxy could not be reached.";
    case "invalidResponse":
      return "Vibe-Proxy returned an unexpected response.";
    case "requestFailed":
      return "The Vibe-Proxy request failed.";
  }
}

export type VibeProxyUsageStage =
  /** Integration switched off. */
  | { readonly kind: "disabled" }
  /** Enabled, but the base URL or key is missing. */
  | { readonly kind: "unconfigured"; readonly missing: readonly ("baseUrl" | "apiKey")[] }
  /** Configured, nothing fetched yet, first request in flight. */
  | { readonly kind: "loading" }
  /** Configured, nothing fetched, and the request finished without data. */
  | { readonly kind: "empty"; readonly problem: string | null }
  /** A snapshot is renderable. It may be a persisted one from an earlier visit. */
  | {
      readonly kind: "accounts";
      readonly accounts: readonly VibeProxyUsageAccount[];
      readonly fetchedAt: string;
      readonly stale: boolean;
      readonly problem: string | null;
    };

export interface VibeProxyUsageStageInput {
  readonly settings: Pick<VibeProxySettings, "enabled" | "baseUrl" | "apiKey" | "apiKeyRedacted">;
  readonly result: VibeProxyUsageResult | null;
  readonly isRefreshing: boolean;
  /** Transport-level failure, distinct from an upstream refresh problem. */
  readonly transportError: string | null;
}

/**
 * Single decision point for what the accounts area renders.
 *
 * A stored key never comes back over the wire, so `apiKeyRedacted` is what
 * proves one exists; treating an empty `apiKey` as unconfigured would make the
 * page flip to a setup prompt on every reload.
 */
export function resolveVibeProxyUsageStage(input: VibeProxyUsageStageInput): VibeProxyUsageStage {
  const { settings } = input;
  if (!settings.enabled) return { kind: "disabled" };

  const missing: ("baseUrl" | "apiKey")[] = [];
  if (settings.baseUrl.trim().length === 0) missing.push("baseUrl");
  if (settings.apiKey.trim().length === 0 && !settings.apiKeyRedacted) missing.push("apiKey");
  if (missing.length > 0) return { kind: "unconfigured", missing };

  const problem =
    input.transportError ??
    (input.result?.refreshProblem ? describeRefreshProblem(input.result.refreshProblem) : null);
  const snapshot = input.result?.snapshot ?? null;

  if (snapshot !== null) {
    return {
      kind: "accounts",
      accounts: snapshot.accounts,
      fetchedAt: snapshot.fetchedAt,
      // Data is stale whenever the page is still fetching, or the fetch that
      // just ran did not produce this snapshot.
      stale: input.isRefreshing || problem !== null || input.result?.refreshed !== true,
      problem,
    };
  }

  if (input.isRefreshing) return { kind: "loading" };
  return { kind: "empty", problem };
}

/** Copy for the configuration prompt, driven by which field is missing. */
export function describeMissingConfiguration(missing: readonly ("baseUrl" | "apiKey")[]): string {
  const wantsBaseUrl = missing.includes("baseUrl");
  const wantsApiKey = missing.includes("apiKey");
  if (wantsBaseUrl && wantsApiKey) return "Add a base URL and an API key to load usage.";
  if (wantsBaseUrl) return "Add a base URL to load usage.";
  return "Add an API key to load usage.";
}
