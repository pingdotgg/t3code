/**
 * Pure parsing for OpenCode Zen subscription limits.
 *
 * The OpenCode CLI stores credentials in `auth.json` under its XDG data dir
 * (`~/.local/share/opencode`), a map keyed by provider id; the `opencode`
 * entry carries the Zen API key. The figures come from the Zen console's
 * `/zen/go/v1/usage` route, which answers per-window consumption for Go
 * subscriptions and a 403 `EntitlementError` for pay-as-you-go credit keys.
 * Neither shape is a published contract, so every parser here is defensive:
 * unrecognised documents yield `null`/empty rather than an error.
 *
 * @module usageLimitsOpenCode
 */
import type { UsageLimitWindow } from "@t3tools/contracts";

export type OpenCodeAuthState =
  /** A Zen API key the usage endpoint accepts. */
  | { readonly kind: "zen"; readonly key: string }
  /** Signed in, but only to pass-through providers (Anthropic, OpenAI, ...). */
  | { readonly kind: "other" };

/**
 * Reads the CLI's `auth.json` map. Only the `opencode` entry's API key can
 * query the Zen usage endpoint; other entries prove the CLI is in use but
 * carry pass-through credentials whose limits belong to those providers.
 */
export function parseOpenCodeAuthState(raw: string): OpenCodeAuthState | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const record = document as Record<string, unknown>;

  const zen = record.opencode;
  if (typeof zen === "object" && zen !== null) {
    const { type, key } = zen as Record<string, unknown>;
    if (type === "api" && typeof key === "string" && key.trim().length > 0) {
      return { kind: "zen", key: key.trim() };
    }
  }

  for (const value of Object.values(record)) {
    if (isCredentialEntry(value)) return { kind: "other" };
  }
  return null;
}

/** Matches the CLI's credential shapes: oauth, wellknown, or a non-blank key. */
function isCredentialEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { type, key, access } = value as Record<string, unknown>;
  if (type === "oauth") return typeof access === "string" && access.trim().length > 0;
  return typeof key === "string" && key.trim().length > 0;
}

/** The error marker in Zen's non-2xx bodies, e.g. `EntitlementError`. */
export function parseOpenCodeErrorType(document: unknown): string | null {
  if (typeof document !== "object" || document === null) return null;
  const error = (document as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return null;
  const type = (error as Record<string, unknown>).type;
  return typeof type === "string" && type.trim().length > 0 ? type.trim() : null;
}

/**
 * The known usage windows, in display order. The rolling window is Zen's
 * 5-hour session window (the gateway's limit errors call it "5 hour").
 */
const WINDOW_TITLES: readonly { id: string; label: string; detail: string }[] = [
  { id: "rolling", label: "Session limit", detail: "Rolling 5-hour window" },
  { id: "weekly", label: "Weekly limit", detail: "Weekly window" },
  { id: "monthly", label: "Monthly limit", detail: "Monthly window" },
];

/** `black_rolling` → "Black rolling". */
function humanizeId(id: string): string {
  const words = id.replaceAll(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** See {@link usageLimitsClaude}: clamped, not rounded. */
function clampUtilization(value: number): number {
  return Math.min(Math.max(value, 0), 999);
}

function readInstant(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readWindow(
  value: unknown,
  title: { id: string; label: string; detail: string | null },
): UsageLimitWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const { percent, resetsAt } = value as Record<string, unknown>;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return {
    id: title.id,
    label: title.label,
    detail: title.detail,
    utilization: clampUtilization(percent),
    resetsAt: readInstant(resetsAt),
  };
}

/**
 * Extracts rate windows from `/zen/go/v1/usage`.
 *
 * The response nests `{status, percent, resetsAt}` per window under `usage`.
 * Known windows keep curated labels and order; unknown keys (a future tier's
 * windows) still render with a humanised label instead of being dropped.
 */
export function parseOpenCodeUsageWindows(document: unknown): UsageLimitWindow[] {
  if (typeof document !== "object" || document === null) return [];
  const usage = (document as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return [];
  const record = usage as Record<string, unknown>;

  const windows: UsageLimitWindow[] = [];
  for (const title of WINDOW_TITLES) {
    const window = readWindow(record[title.id], title);
    if (window !== null) windows.push(window);
  }
  for (const [id, value] of Object.entries(record)) {
    if (WINDOW_TITLES.some((title) => title.id === id)) continue;
    const window = readWindow(value, { id, label: humanizeId(id), detail: null });
    if (window !== null) windows.push(window);
  }
  return windows;
}
