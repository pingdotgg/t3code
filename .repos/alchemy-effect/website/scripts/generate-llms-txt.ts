/**
 * Generates `public/llms.txt` and `public/llms-full.txt` — navigation
 * indexes of the docs pages, grouped by section, with title + description
 * pulled from each page's frontmatter.
 *
 * `llms.txt` covers the guides and concept docs and links to
 * `llms-full.txt`, which additionally lists every generated per-resource
 * API reference page (the Providers section) and is much larger.
 *
 * Run with: `bun scripts/generate-llms-txt.ts`
 *
 * Section ordering, headings, and prose intros are configured here.
 * Page metadata (title, description) comes from the source frontmatter,
 * so editing a page's frontmatter is enough to update llms.txt.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../src/content/docs");
const outFile = path.resolve(here, "../public/llms.txt");
const outFullFile = path.resolve(here, "../public/llms-full.txt");
const siteUrl = "https://alchemy.run";

interface Page {
  /** URL path, e.g. "/infrastructure-as-effects/binding" */
  href: string;
  /** Path relative to docs dir without extension, e.g. "infrastructure-as-effects/binding" */
  slug: string;
  title: string;
  description: string;
  draft: boolean;
  /** `sidebar.order` from frontmatter; `Infinity` when unset. */
  order: number;
}

interface Section {
  /** H2 heading */
  heading: string;
  /** Optional prose paragraph after the heading. */
  intro?: string;
  /**
   * Pages to include. Either a list of explicit slugs (relative to docs dir,
   * no extension) in the desired order, or a directory to enumerate
   * alphabetically.
   */
  pages: { slugs: string[] } | { directory: string; exclude?: string[] };
}

const SECTIONS: Section[] = [
  {
    heading: "Start here",
    pages: {
      slugs: ["what-is-alchemy", "getting-started", "migrating-from-v1"],
    },
  },
  {
    heading: "CLI",
    intro:
      "Every command runs through your package manager: bun alchemy <command>. Command pages by role, plus the Adopting Resources and Inspecting State guides.",
    pages: {
      slugs: [
        "cli/index",
        "cli/deploy",
        "cli/plan",
        "cli/destroy",
        "cli/nuke",
        "cli/adopting-resources",
        "cli/dev",
        "cli/tail",
        "cli/logs",
        "cli/login",
        "cli/profile",
        "cli/state",
        "cli/inspecting-state",
        "cli/aws",
        "cli/cloudflare",
      ],
    },
  },
  {
    heading: "Infrastructure as Code",
    intro:
      "The noun graph and its semantics: Stacks of Resources and Actions, data flow via Inputs & Outputs and References, deploy behavior via the Resource lifecycle and Providers.",
    pages: {
      slugs: [
        "infrastructure-as-code/stack",
        "infrastructure-as-code/resource",
        "infrastructure-as-code/action",
        "infrastructure-as-code/outputs",
        "infrastructure-as-code/references",
        "infrastructure-as-code/resource-lifecycle",
        "infrastructure-as-code/provider",
        "infrastructure-as-code/custom-provider",
      ],
    },
  },
  {
    heading: "Infrastructure as Effects",
    intro:
      "How app code and infrastructure compose: Functions & Servers, Bindings, the init/runtime Phases, and Layers.",
    pages: {
      slugs: [
        "infrastructure-as-effects/index",
        "infrastructure-as-effects/functions-and-servers",
        "infrastructure-as-effects/binding",
        "infrastructure-as-effects/event-sources",
        "infrastructure-as-effects/sinks",
        "infrastructure-as-effects/phases",
        "infrastructure-as-effects/layers",
        "infrastructure-as-effects/circular-bindings",
        "infrastructure-as-effects/custom-runtime",
      ],
    },
  },
  {
    heading: "APIs",
    intro:
      "Typed calls between Functions and Servers: schemaless RPC for internal communication, Effect RPC and Effect HTTP for trust boundaries.",
    pages: {
      slugs: [
        "apis/index",
        "apis/schemaless",
        "apis/effect-rpc",
        "apis/effect-http",
      ],
    },
  },
  {
    heading: "Environments — the same app in many places",
    intro:
      "Stages, credential profiles, auth providers, secrets and config, local development, and CI.",
    pages: {
      slugs: [
        "environments/stages",
        "environments/profiles",
        "environments/auth-providers",
        "environments/custom-auth-provider",
        "environments/secrets",
        "environments/local-development",
        "environments/ci",
      ],
    },
  },
  {
    heading: "State Store",
    pages: { slugs: ["state-store/index", "state-store/custom-state-store"] },
  },
  {
    heading: "Project structure",
    intro:
      "Scaling the codebase: file conventions for one stack, monorepos for many — single Stack or one per package.",
    pages: {
      slugs: ["project-structure/file-layout", "project-structure/monorepo"],
    },
  },
  {
    heading: "Testing & observability",
    intro:
      "Tests run against real clouds: the model, the end-to-end walkthrough, provider-lifecycle testing, and the harness reference.",
    pages: {
      slugs: [
        "testing/index",
        "testing/testing-a-stack",
        "testing/testing-providers",
        "testing/test-harness",
        "testing/observability",
      ],
    },
  },
  {
    heading: "Cloudflare — start here",
    intro:
      "The Cloudflare hub: overview (resources + recipes) and setup (install, account, OAuth vs API token, profiles).",
    pages: { slugs: ["cloudflare/index", "cloudflare/setup"] },
  },
  {
    heading: "Cloudflare — tutorial",
    intro:
      "A linear five-part walkthrough from zero to a tested, locally-developed, CI-deployed Cloudflare project. Each part builds on the previous one.",
    pages: {
      slugs: [
        "cloudflare/tutorial/part-1",
        "cloudflare/tutorial/part-2",
        "cloudflare/tutorial/part-3",
        "cloudflare/tutorial/part-4",
        "cloudflare/tutorial/part-5",
      ],
    },
  },
  {
    heading: "Cloudflare — Compute",
    pages: { directory: "cloudflare/compute" },
  },
  {
    heading: "Cloudflare — Frontend",
    pages: { directory: "cloudflare/frontend" },
  },
  {
    heading: "Cloudflare — APIs",
    pages: { directory: "cloudflare/apis" },
  },
  {
    heading: "Cloudflare — Data",
    pages: { directory: "cloudflare/data" },
  },
  {
    heading: "Cloudflare — Messaging & events",
    pages: { directory: "cloudflare/messaging" },
  },
  {
    heading: "Cloudflare — Email",
    pages: { directory: "cloudflare/email" },
  },
  {
    heading: "Cloudflare — AI",
    pages: { directory: "cloudflare/ai" },
  },
  {
    heading: "Cloudflare — Security & secrets",
    pages: { directory: "cloudflare/security" },
  },
  {
    heading: "Cloudflare — Observability",
    pages: { directory: "cloudflare/observability" },
  },
  {
    heading: "Cloudflare — Networking",
    pages: { directory: "cloudflare/networking" },
  },
  {
    heading: "AWS — start here",
    intro:
      "The AWS hub: overview (runtimes + resources + recipes), setup (credentials, profiles, region), and the Lambda vs ECS vs EKS vs EC2 decision page.",
    pages: {
      slugs: ["aws/index", "aws/setup", "aws/compute/choosing-a-runtime"],
    },
  },
  {
    heading: "AWS — tutorial",
    intro:
      "A linear five-part walkthrough from zero to a tested, CI-deployed AWS project. Each part builds on the previous one.",
    pages: {
      slugs: [
        "aws/tutorial/part-1",
        "aws/tutorial/part-2",
        "aws/tutorial/part-3",
        "aws/tutorial/part-4",
        "aws/tutorial/part-5",
      ],
    },
  },
  {
    heading: "AWS — Compute",
    pages: { directory: "aws/compute" },
  },
  {
    heading: "AWS — Frontend",
    pages: { directory: "aws/frontend" },
  },
  {
    heading: "AWS — APIs",
    pages: { directory: "aws/apis" },
  },
  {
    heading: "AWS — Data",
    pages: { directory: "aws/data" },
  },
  {
    heading: "AWS — Messaging & events",
    pages: { directory: "aws/messaging" },
  },
  {
    heading: "AWS — Security & secrets",
    pages: { directory: "aws/security" },
  },
  {
    heading: "AWS — Observability",
    pages: { directory: "aws/observability" },
  },
  {
    heading: "AWS — Networking",
    pages: { directory: "aws/networking" },
  },
  {
    heading: "PlanetScale",
    intro:
      "Serverless MySQL & Postgres as Stack resources. Composes with Cloudflare Hyperdrive and Drizzle — those guides are listed under Cloudflare.",
    pages: {
      slugs: [
        "planetscale/index",
        "planetscale/setup",
        "planetscale/data/postgres",
        "planetscale/data/mysql",
        "planetscale/data/migrations",
        "planetscale/data/credentials",
        "planetscale/data/backups",
        "planetscale/guides/preview-branches",
        "planetscale/guides/drizzle",
      ],
    },
  },
  {
    heading: "Neon",
    intro:
      "Serverless Postgres with copy-on-write branching as Stack resources. Composes with Cloudflare Hyperdrive; branch-per-PR guides are listed under Cloudflare.",
    pages: {
      slugs: [
        "neon/index",
        "neon/setup",
        "neon/data/branching",
        "neon/data/connections",
        "neon/data/migrations",
        "neon/guides/preview-branches",
        "neon/guides/drizzle",
      ],
    },
  },
  {
    heading: "Axiom",
    intro:
      "Observability as Stack resources — datasets, monitors, notifiers. The exporter-Layer pattern is documented in Concepts → Observability.",
    pages: {
      slugs: [
        "axiom/index",
        "axiom/setup",
        "axiom/data/ingest",
        "axiom/guides/alerting",
        "axiom/guides/dashboards",
        "axiom/guides/annotations",
      ],
    },
  },
  {
    heading: "GitHub",
    intro:
      "Repos, secrets, variables, and repository event sources as Stack resources; the CI/CD guides live under Guides and each cloud's tutorial part 5.",
    pages: {
      slugs: [
        "github/index",
        "github/setup",
        "github/repository",
        "github/actions-config",
        "github/events",
      ],
    },
  },
  {
    heading: "Docker",
    intro:
      "Local and CI Docker as Stack resources — images, containers, networks, and volumes driven through the active Docker CLI context; cloud container runtimes (Cloudflare Containers, ECS) consume the pushed image refs from their own hubs.",
    pages: {
      slugs: [
        "docker/index",
        "docker/setup",
        "docker/local-services",
        "docker/build-and-push",
      ],
    },
  },
  {
    heading: "SQL",
    intro:
      "One home for SQL in alchemy — low-level effect-sql clients (alchemy/SQL), Drizzle ORM, the migrationsDir contract, and the per-execution connection lifecycle; Worker runtime wiring lives under Cloudflare → Data.",
    pages: {
      slugs: [
        "sql/index",
        "sql/effect-sql/postgres",
        "sql/effect-sql/d1",
        "sql/effect-sql/migrations",
        "sql/effect-sql/lifecycle",
        "sql/drizzle/postgres",
        "sql/drizzle/d1",
        "sql/drizzle/migrations",
      ],
    },
  },
  {
    heading: "Command",
    intro:
      "Cloud-agnostic local process primitives — memoized builds, one-off commands, and dev servers; the static-site guides in each cloud hub consume them under the hood.",
    pages: {
      slugs: ["command/index", "command/memoization", "command/dev-servers"],
    },
  },
];

const PROVIDERS_INTRO_BASE = `Per-resource API reference, generated from JSDoc on the source \`.ts\` files via \`bun generate:api-reference\`. Each page documents the resource's input properties (with types, defaults, and constraints), output attributes, and Quick Reference / Examples sections derived from \`@section\` / \`@example\` JSDoc tags.`;

const PROVIDERS_INTRO = `${PROVIDERS_INTRO_BASE} Grouped by cloud below.`;

/**
 * Enumerates every generated provider page under `providers/{Cloud}/...`,
 * grouped by cloud. These pages are produced by `build:reference` (which runs
 * before this script in the build), so they exist on disk at generation time
 * even though they are gitignored.
 */
async function renderProvidersSection(): Promise<string> {
  const providersDir = path.join(docsDir, "providers");
  let clouds: string[];
  try {
    const entries = await readdir(providersDir, { withFileTypes: true });
    clouds = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return `## Providers\n\n${PROVIDERS_INTRO}`;
    throw err;
  }

  const blocks: string[] = [`## Providers`, PROVIDERS_INTRO];
  for (const cloud of clouds) {
    const slugs = await listSlugs(`providers/${cloud}`);
    const pages = (await Promise.all(slugs.map(loadPage)))
      .filter((p) => !p.draft)
      // Starlight serves provider routes lowercased (e.g. the CamelCase source
      // `providers/AWS/S3/Bucket.md` is reachable at `/providers/aws/s3/bucket`).
      .map((p) => ({ ...p, href: p.href.toLowerCase() }))
      .sort((a, b) => a.title.localeCompare(b.title));
    if (pages.length === 0) continue;
    blocks.push(`### ${cloud}`);
    blocks.push(pages.map(renderPage).join("\n"));
  }
  return blocks.join("\n\n");
}

const HEADER = `# Alchemy

> Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that combines cloud infrastructure and application logic into a single, type-safe program powered by [Effect](https://effect.website). Resources are declared as Effects; bindings wire IAM, env vars, and typed SDKs in one call; deploys and runtime share the same code.

This file is a navigation index for the documentation site at ${siteUrl}. Guide and concept pages are listed below with their URL and a one-line summary, so an agent can pick the right page in one hop. The per-resource API reference is indexed separately in [llms-full.txt](${siteUrl}/llms-full.txt).`;

const FULL_HEADER = `# Alchemy

> Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that combines cloud infrastructure and application logic into a single, type-safe program powered by [Effect](https://effect.website). Resources are declared as Effects; bindings wire IAM, env vars, and typed SDKs in one call; deploys and runtime share the same code.

This file is a navigation index for the documentation site at ${siteUrl}. Every page under \`/src/content/docs/\` is listed below with its URL and a one-line summary, so an agent can pick the right page in one hop. This is the full index including every per-resource API reference page; the smaller [llms.txt](${siteUrl}/llms.txt) covers just the guides and concept docs.`;

function parseFrontmatter(source: string): Record<string, string> {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = source.slice(3, end);
  const out: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Extracts the nested `sidebar.order` value from a frontmatter block.
 * Starlight uses this to order autogenerated sidebar groups; we mirror it
 * so llms.txt lists pages in the same order the sidebar shows them.
 * Returns `Infinity` when unset, so unordered pages sort after ordered ones.
 */
function parseSidebarOrder(source: string): number {
  if (!source.startsWith("---")) return Number.POSITIVE_INFINITY;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return Number.POSITIVE_INFINITY;
  const block = source.slice(3, end);
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^sidebar:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) break; // dedented out of the sidebar block
      const m = lines[j].match(/^\s+order:\s*(-?[\d.]+)\s*$/);
      if (m) return Number.parseFloat(m[1]);
    }
    break;
  }
  return Number.POSITIVE_INFINITY;
}

async function loadPage(slug: string): Promise<Page> {
  const candidates = [`${slug}.mdx`, `${slug}.md`];
  for (const rel of candidates) {
    const full = path.join(docsDir, rel);
    try {
      const source = await readFile(full, "utf8");
      const fm = parseFrontmatter(source);
      const title = fm.title;
      const description = fm.description ?? fm.excerpt ?? "";
      if (!title) {
        throw new Error(`Missing title in frontmatter: ${rel}`);
      }
      return {
        // `foo/index.mdx` is served at `/foo`.
        href: `/${slug}`.replace(/\/index$/, "") || "/",
        slug,
        title,
        description,
        draft: fm.draft === "true" || (fm.draft as unknown as boolean) === true,
        order: parseSidebarOrder(source),
      };
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`Page not found: ${slug} (looked for .mdx and .md)`);
}

async function listSlugs(
  directory: string,
  exclude: string[] = [],
): Promise<string[]> {
  const dir = path.join(docsDir, directory);
  const entries = await readdir(dir, { withFileTypes: true });
  const slugs: string[] = [];
  for (const entry of entries) {
    const rel = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      slugs.push(...(await listSlugs(rel, exclude)));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (ext !== ".md" && ext !== ".mdx") continue;
    const slug = `${directory}/${entry.name.slice(0, -ext.length)}`;
    if (exclude.includes(slug)) continue;
    slugs.push(slug);
  }
  slugs.sort();
  return slugs;
}

function byOrderThenTitle(a: Page, b: Page): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.title.localeCompare(b.title);
}

function renderPage(page: Page): string {
  const url = `${siteUrl}${page.href}`;
  const desc = page.description ? ` — ${page.description}` : "";
  return `- [${page.title}](${url})${desc}`;
}

async function main() {
  const sections: string[] = [];

  for (const section of SECTIONS) {
    const isDirectory = !("slugs" in section.pages);
    const slugs =
      "slugs" in section.pages
        ? section.pages.slugs
        : await listSlugs(section.pages.directory, section.pages.exclude);
    const pages = (await Promise.all(slugs.map(loadPage))).filter(
      (p) => !p.draft,
    );
    // Directory sections mirror the sidebar's `sidebar.order` ordering; slug
    // sections keep the curated order they were declared in.
    if (isDirectory) pages.sort(byOrderThenTitle);

    sections.push(`## ${section.heading}`);
    if (section.intro) sections.push(section.intro);
    sections.push(pages.map(renderPage).join("\n"));
  }

  const fullBody =
    [FULL_HEADER, ...sections, await renderProvidersSection()].join("\n\n") +
    "\n";
  await writeFile(outFullFile, fullBody, "utf8");
  console.log(`Wrote ${outFullFile}`);

  const fullSizeKb = Math.round(Buffer.byteLength(fullBody, "utf8") / 1024);
  const referenceSection = [
    `## API reference`,
    `${PROVIDERS_INTRO_BASE}\n\nThe per-resource pages are indexed in [llms-full.txt](${siteUrl}/llms-full.txt), which repeats this entire file plus one link per resource. Warning: it is large (~${fullSizeKb} KB) — only fetch it when you need to locate a specific resource's reference page.`,
  ];

  const body = [HEADER, ...sections, ...referenceSection].join("\n\n") + "\n";
  await writeFile(outFile, body, "utf8");
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
