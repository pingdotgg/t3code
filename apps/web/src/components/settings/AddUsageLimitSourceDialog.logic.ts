import { type UnifiedSettings, UsageLimitSourceId } from "@t3tools/contracts";

/**
 * Only the URL's host is used, so two hubs under different paths on one host
 * share a base id. Dots and dashes stay so `foo-bar.com` and `foo.bar.com` do
 * not collide; anything else in the host, such as a port's colon, becomes a
 * dash. A string that does not parse falls back to sanitizing the raw input.
 */
export function sourceIdFromUrl(
  url: string,
  sources: UnifiedSettings["usageLimitSources"],
): UsageLimitSourceId {
  // Adding a saved hub's URL again updates that hub, e.g. to replace its key.
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
