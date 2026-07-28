/**
 * Icon resolution for the docs chrome (tab bar + sidebar group headings).
 *
 * Two sources, both 24×24 viewBox and theme-adaptive via `currentColor`:
 * - lucide (stroke outlines) for generic concepts (tutorial, data, guides…)
 * - simple-icons (fill) for official provider brand marks (Cloudflare, AWS…)
 */
import { icons as lucide } from "@iconify-json/lucide";
import { icons as brands } from "@iconify-json/simple-icons";

const l = (name: string): string | undefined => lucide.icons[name]?.body;
const b = (name: string): string | undefined => brands.icons[name]?.body;

/** Tab bar icons, keyed by tab label (see docs-tabs.ts). */
export const TAB_ICONS: Record<string, string | undefined> = {
  Core: l("book-open"),
  CLI: l("square-terminal"),
  Cloudflare: b("cloudflare"),
  AWS: b("amazonwebservices"),
  PlanetScale: b("planetscale"),
  Neon: b("neon"),
  Axiom: l("activity"),
  GitHub: b("github"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Drizzle: b("drizzle"),
  SQL: l("database"),
  Command: l("square-terminal"),
  Reference: l("code"),
  Blog: l("newspaper"),
};

/** Sidebar group-heading icons, keyed by (normalized) group label. */
const GROUP_ICONS: Record<string, string | undefined> = {
  Tutorial: l("graduation-cap"),
  Deploy: l("rocket"),
  Develop: l("refresh-cw"),
  Auth: l("key-round"),
  State: l("hard-drive"),
  Providers: l("plug"),
  "Infrastructure as Code": l("code"),
  "Infrastructure as Effects": l("layers"),
  "State Store": l("hard-drive"),
  "Project structure": l("folder-tree"),
  Environments: l("sliders-horizontal"),
  "Testing & observability": l("flask-conical"),
  Compute: l("zap"),
  Frontend: l("layout-template"),
  APIs: l("braces"),
  Data: l("database"),
  Messaging: l("send"),
  "Messaging & Events": l("send"),
  "Messaging & events": l("send"),
  Email: l("mail"),
  AI: l("sparkles"),
  "Security & secrets": l("lock"),
  Observability: l("activity"),
  Networking: l("globe"),
  Guides: l("map"),
  Resources: l("boxes"),
  Concepts: l("book-text"),
  // Reference tab: provider groups get their official brand marks.
  AWS: b("amazonwebservices"),
  Cloudflare: b("cloudflare"),
  GitHub: b("github"),
  Neon: b("neon"),
  Planetscale: b("planetscale"),
  PlanetScale: b("planetscale"),
  Axiom: l("activity"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Drizzle: b("drizzle"),
  SQL: l("database"),
  "Effect SQL": l("database-zap"),
  Migrations: l("list-ordered"),
  Command: l("square-terminal"),
  Stripe: b("stripe"),
};

/**
 * Resolve a sidebar group label to an icon body. Qualified labels like
 * "Compute — advanced" resolve via their base name.
 */
export function sidebarGroupIcon(label: string): string | undefined {
  return GROUP_ICONS[label] ?? GROUP_ICONS[label.split("—")[0].trim()];
}
