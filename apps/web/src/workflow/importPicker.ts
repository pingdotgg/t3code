import type { ImportableWorkItemView } from "@t3tools/contracts/workSource";

export interface FilterState {
  readonly search: string;
  readonly assignedToMe: boolean;
  readonly hideTasked: boolean;
}

type ViewerMap = Record<string, { id: string; aliases: ReadonlyArray<string> } | null>;

export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

export const selectionKey = (r: Pick<ImportableWorkItemView, "sourceId" | "externalId">): string =>
  `${r.sourceId}:${r.externalId}`;

export const defaultChecked = (r: ImportableWorkItemView): boolean =>
  r.mappedTicketId === null && r.lifecycle === "open";

export const applyPickerFilters = (
  rows: ReadonlyArray<ImportableWorkItemView>,
  f: FilterState,
  viewer: ViewerMap,
): ReadonlyArray<ImportableWorkItemView> => {
  const raw = f.search.trim();
  const url = isUrl(raw) ? raw.toLowerCase() : null;
  const q = url ? null : raw.toLowerCase();
  return rows.filter((r) => {
    if (f.hideTasked && r.mappedTicketId !== null) return false;
    if (f.assignedToMe) {
      const v = viewer[r.sourceId];
      if (v === null || v === undefined) return false;
      if (!r.assignees.some((a) => v.aliases.includes(a))) return false;
    }
    if (url !== null) return r.url.trim().toLowerCase() === url; // url is already trimmed+lowercased
    if (q !== null && q.length > 0 && !`${r.title} ${r.displayRef}`.toLowerCase().includes(q))
      return false;
    return true;
  });
};

// keys: `${sourceId}:${externalId}` -> { [sourceId]: externalId[] }
// Uses indexOf(":") (first colon) to split, so externalIds containing colons still work
// (sourceId is a UUID with no colon).
export const groupSelectedBySource = (keys: ReadonlySet<string>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const idx = key.indexOf(":");
    if (idx === -1) continue;
    const sourceId = key.slice(0, idx);
    const externalId = key.slice(idx + 1);
    (out[sourceId] ??= []).push(externalId);
  }
  return out;
};
