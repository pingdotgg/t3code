/**
 * The horizontal docs tab bar (bun.com-style primary navigation).
 *
 * Each tab owns a URL prefix and a sidebar: the tab bar renders in the docs
 * header (see `components/starlight/DocsTabs.astro`) and the route middleware
 * (`docs-tabs-sidebar.ts`) swaps in the sidebar group whose label matches the
 * active tab. The `label` here MUST match the top-level group label in
 * `astro.config.mjs`'s `sidebar` array.
 *
 * Placement (`slot`):
 * - "primary"  — always-visible tabs on the left. Reserved for providers with
 *   runtimes you build on (plus the flagship databases) — scarce real estate.
 * - "more"     — residents of the "More ▾" dropdown, grouped by `category`.
 *   Full hubs, identical skeleton; only the entry point differs. Promotion
 *   is moving an entry from "more" to "primary".
 * - "end"      — meta sections pinned to the right (Reference, Blog).
 */
export interface DocsTab {
  label: string;
  href: string;
  /** URL path prefixes this tab owns (matched on segment boundaries). */
  prefixes: string[];
  slot: "primary" | "more" | "end";
  /** Dropdown category heading (only for slot: "more"). */
  category?: string;
  /** One-line scope hint shown in the dropdown. */
  hint?: string;
}

export const DOCS_TABS: DocsTab[] = [
  { label: "Core", href: "/getting-started", prefixes: [], slot: "primary" },
  { label: "CLI", href: "/cli", prefixes: ["/cli"], slot: "primary" },
  {
    label: "Cloudflare",
    href: "/cloudflare",
    prefixes: ["/cloudflare", "/providers/cloudflare"],
    slot: "primary",
  },
  {
    label: "AWS",
    href: "/aws",
    prefixes: ["/aws", "/providers/aws"],
    slot: "primary",
  },
  {
    label: "PlanetScale",
    href: "/planetscale",
    prefixes: ["/planetscale", "/providers/planetscale"],
    slot: "primary",
  },
  {
    label: "Neon",
    href: "/neon",
    prefixes: ["/neon", "/providers/neon"],
    slot: "primary",
  },
  {
    label: "Axiom",
    href: "/axiom",
    prefixes: ["/axiom", "/providers/axiom"],
    slot: "more",
    category: "Observability",
    hint: "logs · traces · alerts",
  },
  {
    label: "GitHub",
    href: "/github",
    prefixes: ["/github", "/providers/github"],
    slot: "more",
    category: "Source & CI",
    hint: "repos · secrets · events",
  },
  {
    label: "Docker",
    href: "/docker",
    prefixes: ["/docker", "/providers/docker"],
    slot: "more",
    category: "Containers",
    hint: "images · containers · networks",
  },
  {
    label: "SQL",
    href: "/sql",
    prefixes: ["/sql", "/drizzle", "/providers/drizzle", "/providers/sql"],
    slot: "more",
    category: "Data",
    hint: "effect-sql · drizzle · migrations",
  },
  {
    label: "Command",
    href: "/command",
    prefixes: ["/command", "/providers/command"],
    slot: "more",
    category: "Toolchain",
    hint: "build · dev · exec",
  },
  // A provider's reference pages belong to its hub tab (the prefixes
  // above claim /providers/{provider} first) — the Reference tab owns
  // only the directory landing plus providers without a hub.
  {
    label: "Reference",
    href: "/providers",
    prefixes: ["/providers"],
    slot: "end",
  },
  { label: "Blog", href: "/blog", prefixes: ["/blog"], slot: "end" },
];

const matches = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Resolve the active tab for a pathname. Core (the platform tab) is the
 * fallback for every docs page that no provider/reference/blog prefix claims
 * (what-is-alchemy, getting-started, concepts, guides).
 */
export function activeTab(pathname: string): DocsTab {
  const normalized = pathname.replace(/\/$/, "") || "/";
  for (const tab of DOCS_TABS) {
    if (tab.prefixes.some((p) => matches(normalized, p))) return tab;
  }
  return DOCS_TABS[0];
}
