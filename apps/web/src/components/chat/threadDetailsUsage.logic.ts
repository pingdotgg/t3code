import type { ServerProviderUsageWindow } from "@t3tools/contracts";

export interface UsageWindowGroup {
  /** Null when the windows carry no shared prefix, as with single-pool providers. */
  readonly title: string | null;
  readonly rows: readonly { readonly label: string; readonly window: ServerProviderUsageWindow }[];
}

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * Pool-scoped labels read "Gemini · 5-hour". Group them under the pool name so each row keeps only
 * its window, which fits the narrow panel instead of truncating to "Claude & GPT (sh…".
 */
export function groupUsageWindows(
  windows: readonly ServerProviderUsageWindow[],
): readonly UsageWindowGroup[] {
  const groups = new Map<string | null, UsageWindowGroup["rows"][number][]>();
  for (const window of windows) {
    const split = window.label.lastIndexOf(" · ");
    const title = split > 0 ? window.label.slice(0, split) : null;
    const label = split > 0 ? window.label.slice(split + 3) : window.label;
    const rows = groups.get(title) ?? [];
    rows.push({ label, window });
    groups.set(title, rows);
  }
  // One pool needs no heading; its rows keep their full labels.
  if (groups.size === 1 && !groups.has(null)) {
    return [{ title: null, rows: windows.map((window) => ({ label: window.label, window })) }];
  }
  return [...groups].map(([title, rows]) => ({
    title,
    rows: rows.toSorted((a, b) => KIND_ORDER[a.window.kind] - KIND_ORDER[b.window.kind]),
  }));
}
