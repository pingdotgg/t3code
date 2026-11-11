/**
 * The docs tab bar (primary navigation).
 *
 * Each tab owns a URL prefix and a sidebar: the tab bar renders in the docs
 * header (see `components/starlight/DocsTabs.astro`) and the route middleware
 * (`docs-tabs-sidebar.ts`) swaps in the sidebar group whose label matches the
 * active tab. The `label` here MUST match the top-level group label in
 * `astro.config.ts`'s `sidebar` array.
 *
 * Placement (`slot`):
 * - "start" — always-visible tabs on the left: Alchemy itself (Core, CLI,
 *   Domain), not third-party providers.
 * - "hub"   — provider hubs, grouped by `category`. Desktop renders one
 *   hover dropdown per category (single-hub categories share a
 *   "More" dropdown); the mobile drawer renders the same groups as
 *   headings. Adding a provider means adding one entry here.
 * - "end"   — meta sections pinned to the right (Reference, Blog, Compare).
 */
export interface DocsTab {
  label: string;
  href: string;
  /** URL path prefixes this tab owns (matched on segment boundaries). */
  prefixes: string[];
  slot: "start" | "hub" | "end";
  /** Dropdown category (required for slot: "hub"). */
  category?: DocsCategory;
  /** One-line scope hint shown in the dropdown. */
  hint?: string;
}

/** Hub categories, in header order. */
export const DOCS_CATEGORIES = [
  "Clouds",
  "Containers",
  "Databases",
  "Auth",
  "Payments",
  "Observability",
  "Source & CI",
  "Certificates",
] as const;
export type DocsCategory = (typeof DOCS_CATEGORIES)[number];

const hub = (
  label: string,
  slug: string,
  category: DocsCategory,
  hint: string,
  extraPrefixes: string[] = [],
): DocsTab => ({
  label,
  href: `/${slug}`,
  prefixes: [`/${slug}`, ...extraPrefixes],
  slot: "hub",
  category,
  hint,
});

export const DOCS_TABS: DocsTab[] = [
  { label: "Core", href: "/getting-started", prefixes: [], slot: "start" },
  { label: "CLI", href: "/cli", prefixes: ["/cli"], slot: "start" },
  {
    label: "Domain",
    href: "/domain",
    prefixes: ["/domain", "/providers/domain"],
    slot: "start",
  },

  hub("Cloudflare", "cloudflare", "Clouds", "workers · durable objects · R2 · D1", [
    "/providers/cloudflare",
  ]),
  hub("AWS", "aws", "Clouds", "lambda · ECS · S3 · DynamoDB", ["/providers/aws"]),
  hub("GCP", "gcp", "Clouds", "cloud run · storage · pub/sub", ["/providers/gcp"]),
  hub("Hetzner", "hetzner", "Clouds", "servers · networks · volumes", ["/providers/hetzner"]),
  hub("Fly", "fly", "Clouds", "apps · machines · volumes", ["/providers/fly"]),
  hub("Railway", "railway", "Clouds", "services · environments · volumes", ["/providers/railway"]),

  hub("PlanetScale", "planetscale", "Databases", "MySQL · Postgres · branches", [
    "/providers/planetscale",
  ]),
  hub("Neon", "neon", "Databases", "serverless Postgres · branches", ["/providers/neon"]),
  hub("Turso", "turso", "Databases", "libSQL · groups · tokens", ["/providers/turso"]),
  hub("Prisma", "prisma", "Databases", "Prisma Postgres · client", ["/providers/prisma"]),
  hub("SQL", "sql", "Databases", "effect-sql · drizzle · migrations", [
    "/drizzle",
    "/providers/drizzle",
    "/providers/sql",
  ]),

  hub("Better Auth", "better-auth", "Auth", "sessions · plugins · database layers", [
    "/providers/betterauth",
  ]),
  hub("Stripe", "stripe", "Payments", "products · prices · webhooks", ["/providers/stripe"]),
  hub("Axiom", "axiom", "Observability", "logs · traces · alerts", ["/providers/axiom"]),
  hub("GitHub", "github", "Source & CI", "repos · secrets · events", ["/providers/github"]),
  hub("ACME", "acme", "Certificates", "accounts · DNS-01 · certificate issuance", [
    "/providers/acme",
  ]),

  hub("Docker", "docker", "Containers", "images · containers · networks", ["/providers/docker"]),
  hub("Kubernetes", "kubernetes", "Containers", "deployments · jobs · manifests · helm", [
    "/providers/kubernetes",
  ]),
  hub("Git", "git", "Source & CI", "self-hosted git · clone · push · pull requests", [
    "/providers/git",
  ]),
  hub("Command", "command", "Source & CI", "build · dev · exec", ["/providers/command"]),

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
  // A marketing page, so it never becomes the active tab.
  { label: "Compare", href: "/compare", prefixes: ["/compare"], slot: "end" },
];

export interface DocsTabSection {
  /** Sub-heading inside a dropdown (only set inside "More"). */
  heading?: DocsCategory;
  tabs: DocsTab[];
}

export interface DocsTabGroup {
  label: DocsCategory | "More";
  sections: DocsTabSection[];
}

const alphabetically = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/**
 * Hub tabs grouped into header dropdowns, in header order. A category with
 * a single hub doesn't earn its own dropdown: it folds into a trailing
 * "More" (under its category sub-heading) until a second hub joins it.
 * Hubs within a dropdown sort alphabetically, and so do the single-hub
 * sections inside "More" (by hub name); `DOCS_TABS` keeps its order for
 * prefix matching.
 */
export const DOCS_TAB_GROUPS: DocsTabGroup[] = (() => {
  const sections = DOCS_CATEGORIES.map((category) => ({
    heading: category,
    tabs: DOCS_TABS.filter((tab) => tab.category === category).sort((a, b) =>
      alphabetically(a.label, b.label),
    ),
  })).filter((section) => section.tabs.length > 0);
  const own = sections.filter((section) => section.tabs.length > 1);
  const more = sections
    .filter((section) => section.tabs.length === 1)
    .sort((a, b) => alphabetically(a.tabs[0]!.label, b.tabs[0]!.label));
  return [
    ...own.map(({ heading, tabs }) => ({ label: heading, sections: [{ tabs }] })),
    ...(more.length > 0 ? [{ label: "More" as const, sections: more }] : []),
  ];
})();

/** Every hub tab in a group, across its sections. */
export const groupTabs = (group: DocsTabGroup): DocsTab[] =>
  group.sections.flatMap((section) => section.tabs);

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
