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

/**
 * A MiniMax source always points at the same vendor URL, so URL reuse would overwrite the
 * account added before it. Every MiniMax addition gets its own ID instead, while CLIProxyAPI
 * hubs keep reusing the ID of the hub with the same URL.
 */
export function sourceIdForKind(
  kind: "cliproxy" | "minimax",
  url: string,
  sources: UnifiedSettings["usageLimitSources"],
): UsageLimitSourceId {
  if (kind === "cliproxy") return sourceIdFromUrl(url, sources);
  let id = "minimax";
  for (let suffix = 2; id in sources; suffix += 1) {
    id = `minimax-${suffix}`;
  }
  return UsageLimitSourceId.make(id);
}
