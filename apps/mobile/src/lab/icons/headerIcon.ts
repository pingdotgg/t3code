// Mobile UI lab: swaps the SF Symbols on native header items for superheroicons template PNGs.
// metro.config.js aliases src/native/swapHeaderIcon.ts to this file when CONN_ICON_LAB=1.
// Variant: headerVariant.ts, written by `node scripts/lab/lab.mts header-icons <solid16|outline24|solid24|solid20>`
// (or CONN_HEADER_ICONS at `start`). Editing it fast-refreshes; no Metro restart.
import { SF_EXTRA_TO_CONCEPT } from "./iconMap";
import { SF_TO_CONCEPT } from "./iconSet.generated";
import { HEADER_ICONS } from "./headerIcons.generated";
import { HEADER_VARIANT } from "./headerVariant";

export function swapHeaderIcon<T>(icon: T): T {
  if (typeof icon !== "object" || icon === null) return icon;
  const candidate = icon as { readonly type?: unknown; readonly name?: unknown };
  if (candidate.type !== "sfSymbol" || typeof candidate.name !== "string") return icon;
  const base = candidate.name.startsWith("conn.") ? candidate.name.slice(5) : candidate.name;
  const concept = SF_TO_CONCEPT[base] ?? SF_EXTRA_TO_CONCEPT[base];
  const source = concept === undefined ? undefined : HEADER_ICONS[HEADER_VARIANT][concept];
  if (source === undefined) return icon;
  return { type: "templateSource", templateSource: source } as T;
}
