/**
 * Icon resolution for the docs chrome (tab bar + sidebar group headings).
 *
 * Three sources, all 24×24 viewBox and theme-adaptive via `currentColor`:
 * - lucide (stroke outlines) for generic concepts (tutorial, data, guides…)
 * - simple-icons (fill) for official provider brand marks (Cloudflare, AWS…)
 * - custom (fill) for brand marks simple-icons has not caught up with yet
 */
import { icons as lucide } from "@iconify-json/lucide";
import { icons as brands } from "@iconify-json/simple-icons";

/**
 * Brand marks in the same body format simple-icons emits, for vendors whose
 * upstream icon is stale. Delete an entry once simple-icons ships the new
 * mark and move the call site back to `b()`.
 */
const custom: Record<string, string> = {
  // Official mark: https://axiom.co/axiom-brand-assets.zip
  // Preserve its 800×690 proportions, centered in our 24×24 icon box.
  axiom:
    '<g transform="translate(0 1.65) scale(0.03)"><path fill="currentColor" d="M792.736 481.458L622.15 196.164C614.327 183.052 595.051 172.324 579.311 172.324H472.812C448.058 172.324 437.911 155.47 450.257 134.872L508.662 37.4525C513.296 29.7211 513.285 20.2029 508.637 12.4796C503.986 4.75638 495.399 0 486.106 0H337.536C321.798 0 302.48 10.7039 294.606 23.7869L5.91039 503.427C-1.9666 516.51 -1.96962 537.921 5.8983 551.006L80.182 674.547C92.5601 695.13 112.858 695.154 125.287 674.599L183.33 578.624C195.763 558.069 216.057 558.093 228.435 578.675L281.058 666.192C288.925 679.277 308.24 689.983 323.979 689.983H667.291C683.024 689.983 702.342 679.277 710.21 666.192L792.65 529.092C800.518 516.006 800.556 494.571 792.736 481.458ZM562.356 467.727C574.656 488.351 564.468 505.228 539.714 505.228H272.672C247.919 505.228 237.791 488.385 250.17 467.803L383.793 245.58C396.17 224.997 416.422 224.997 428.799 245.581L562.356 467.727Z"/></g>',
  // Prisma's 2026 prism mark; simple-icons still ships the pre-2026 logo.
  // Traced from the "Symbol" artwork in Prisma's brand kit (263×264), scaled
  // uniformly and centred — the mark must not be stretched to fill the box.
  // The official Git mark (git-scm.com/downloads/logos, "Git-Icon-Black.svg";
  // logo by Jason Long, CC BY 3.0), used verbatim: its 78×78 viewBox is
  // scaled into the 24×24 box and the fill swapped for currentColor.
  git: '<g transform="scale(0.307692)"><path fill="currentColor" transform="translate(10 10) rotate(-45 29 29)" d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"/></g>',
  prisma:
    '<path fill="currentColor" d="M5.2578 8.4091L0.0455 13.6308V4.8636L4.8828 0.0095V0H13.6385L5.2578 8.4091Z M23.9545 8.3405L8.3231 24H0.0455V15.6572L15.6745 0H23.9545V8.3405Z M19.1078 24H10.3521L14.2685 20.0703L23.9546 10.3667V19.1364L19.1078 24Z"/>',
  // Full-color variant of the same prism mark, band fills taken from the
  // official prisma.io/icon.svg. The docs chrome keeps the currentColor
  // silhouette above; brand-colored surfaces (landing marquee) use this one.
  prismaColor:
    '<path fill="#04D5E7" d="M5.2578 8.4091L0.0455 13.6308V4.8636L4.8828 0.0095V0H13.6385L5.2578 8.4091Z"/><path fill="#FE4352" d="M23.9545 8.3405L8.3231 24H0.0455V15.6572L15.6745 0H23.9545V8.3405Z"/><path fill="#FEBE29" d="M19.1078 24H10.3521L14.2685 20.0703L23.9546 10.3667V19.1364L19.1078 24Z"/>',
  // Stripe's 2025 rebrand mark (svgl.app/library/stripe.svg, viewBox
  // "100 100 312 312"), scaled into the 24×24 box. simple-icons still
  // ships the pre-rebrand "S" glyph.
  stripe:
    '<g transform="scale(0.076923) translate(-100 -100)"><path fill="currentColor" fill-rule="evenodd" d="m120 392 272-57.683V120l-272 58.357z" clip-rule="evenodd"/></g>',
};

const l = (name: string): string | undefined => lucide.icons[name]?.body;
const b = (name: string): string | undefined => brands.icons[name]?.body;
const c = (name: string): string | undefined => custom[name];

/** Tab bar icons, keyed by tab label (see docs-tabs.ts). */
export const TAB_ICONS: Record<string, string | undefined> = {
  Core: l("book-open"),
  CLI: l("square-terminal"),
  Cloudflare: b("cloudflare"),
  AWS: b("amazonwebservices"),
  Hetzner: b("hetzner"),
  Fly: b("flydotio"),
  Railway: b("railway"),
  PlanetScale: b("planetscale"),
  Neon: b("neon"),
  Prisma: c("prisma"),
  // Brand-colored prism for marketing surfaces (see `prismaColor` above).
  PrismaColor: c("prismaColor"),
  Axiom: c("axiom"),
  "Better Auth": l("key-round"),
  GitHub: b("github"),
  Git: c("git"),
  Stripe: c("stripe"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Drizzle: b("drizzle"),
  SQL: l("database"),
  Command: l("square-terminal"),
  Reference: l("code"),
  Blog: l("newspaper"),
  Compare: l("scale"),
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
  Clusters: l("network"),
  Workloads: l("container"),
  Objects: l("file-code"),
  // Reference tab: provider groups get their official brand marks.
  AWS: b("amazonwebservices"),
  Cloudflare: b("cloudflare"),
  Hetzner: b("hetzner"),
  Fly: b("flydotio"),
  Railway: b("railway"),
  GitHub: b("github"),
  Neon: b("neon"),
  Planetscale: b("planetscale"),
  PlanetScale: b("planetscale"),
  Prisma: c("prisma"),
  Axiom: c("axiom"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Drizzle: b("drizzle"),
  "Prisma ORM": b("prisma"),
  SQL: l("database"),
  "Effect SQL": l("database-zap"),
  Migrations: l("list-ordered"),
  Command: l("square-terminal"),
  Stripe: c("stripe"),
};

/**
 * Resolve a sidebar group label to an icon body. Qualified labels like
 * "Compute — advanced" resolve via their base name.
 */
export function sidebarGroupIcon(label: string): string | undefined {
  return GROUP_ICONS[label] ?? GROUP_ICONS[label.split("—")[0].trim()];
}
