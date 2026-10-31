import { type UnifiedSettings, UsageLimitSourceId } from "@t3tools/contracts";

export function sourceIdFromUrl(
  url: string,
  sources: UnifiedSettings["usageLimitSources"],
): UsageLimitSourceId {
  const saved = Object.entries(sources).find(([, source]) => source.url === url);
  if (saved) return UsageLimitSourceId.make(saved[0]);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Settings merge by ID, so adding a different hub must not replace an existing entry.
  const base = `cliproxy-${slug || "hub"}`;
  let id = base;
  for (let suffix = 2; id in sources; suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return UsageLimitSourceId.make(id);
}
