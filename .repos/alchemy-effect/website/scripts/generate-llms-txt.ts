/**
 * Generates `public/llms.txt` and `public/llms-full.txt` — navigation
 * indexes of the docs pages, grouped by section, with title + description
 * pulled from each page's frontmatter.
 *
 * `llms.txt` covers the guides and concept docs and links to
 * `llms-full.txt`, which additionally lists every generated service-level
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
      "Every command runs through your package manager: bun alchemy <command>. Command pages by role, the Programmatic API for running them from scripts, plus the Adopting Resources and Inspecting State guides.",
    pages: {
      slugs: [
        "cli/index",
        "cli/api",
        "cli/deploy",
        "cli/plan",
        "cli/destroy",
        "cli/drift",
        "cli/nuke",
        "cli/adopting-resources",
        "cli/dev",
        "cli/logs",
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
        "infrastructure-as-code/renaming",
        "infrastructure-as-code/provider",
        "infrastructure-as-code/custom-provider",
        "infrastructure-as-code/local-provider",
        "infrastructure-as-code/dns-adapters",
        "infrastructure-as-code/contributions",
      ],
    },
  },
  {
    heading: "Infrastructure as Effects",
    intro:
      "How app code and infrastructure compose: Runtime, Bindings, the Construction and Runtime Phases, and Layers.",
    pages: {
      slugs: [
        "infrastructure-as-effects/runtime",
        "infrastructure-as-effects/binding",
        "infrastructure-as-effects/layers",
        "infrastructure-as-effects/event-sources",
        "infrastructure-as-effects/sinks",
        "infrastructure-as-effects/phases",
        "infrastructure-as-effects/circular-bindings",
        "infrastructure-as-effects/custom-runtime",
        "infrastructure-as-effects/telemetry",
      ],
    },
  },
  {
    heading: "APIs",
    intro:
      "Typed calls between Functions and Servers: schemaless RPC for internal communication, Effect RPC and Effect HTTP for trust boundaries.",
    pages: {
      slugs: ["apis/index", "apis/schemaless", "apis/effect-rpc", "apis/effect-http"],
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
        "environments/secret-providers",
        "environments/doppler",
        "environments/infisical",
        "environments/local-development",
        "environments/worktrees",
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
      slugs: [
        "project-structure/file-layout",
        "project-structure/monorepo",
        "project-structure/monorepo-single-stack",
        "project-structure/monorepo-multi-stack",
      ],
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
      "The Cloudflare hub: overview (resources + recipes), setup (install, account, OAuth vs API token, profiles), and local development.",
    pages: { slugs: ["cloudflare/index", "cloudflare/setup", "cloudflare/local-development"] },
  },
  {
    heading: "Cloudflare — tutorial",
    intro:
      "A linear six-part walkthrough from zero to a tested, locally-developed, CI-deployed, observable Cloudflare project. Each part builds on the previous one.",
    pages: { directory: "cloudflare/tutorial" },
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
    heading: "Prisma — start here",
    pages: { slugs: ["prisma/index", "prisma/setup"] },
  },
  {
    heading: "Prisma — tutorial",
    intro:
      "A four-part walkthrough: a Project, an Effect-native Compute API, Postgres, and a Vite frontend.",
    pages: { directory: "prisma/tutorial" },
  },
  {
    heading: "Prisma — Compute",
    pages: { directory: "prisma/compute" },
  },
  {
    heading: "Prisma — Data",
    pages: { directory: "prisma/data" },
  },
  {
    heading: "Prisma — Frontend",
    pages: { directory: "prisma/frontend" },
  },
  {
    heading: "Prisma — Guides",
    pages: { directory: "prisma/guides" },
  },
  {
    heading: "AWS — start here",
    intro:
      "The AWS hub: overview (runtimes + resources + recipes), setup (credentials, profiles, region), local development, and the Lambda vs ECS vs EKS vs EC2 decision page.",
    pages: {
      slugs: ["aws/index", "aws/setup", "aws/local-development", "aws/compute/choosing-a-runtime"],
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
    pages: { directory: "aws/compute", exclude: ["aws/compute/choosing-a-runtime"] },
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
    heading: "AWS — AI",
    pages: { directory: "aws/ai" },
  },
  {
    heading: "AWS — Messaging & events",
    pages: { directory: "aws/messaging" },
  },
  {
    heading: "AWS — Email",
    pages: { directory: "aws/email" },
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
    heading: "GCP",
    intro:
      "Google Cloud as Stack resources — Cloud Run services and jobs, Firestore, Pub/Sub, BigQuery, Secret Manager, Memorystore. Bindings grant IAM onto a per-host service account.",
    pages: {
      slugs: ["gcp/index", "gcp/setup"],
    },
  },
  {
    heading: "GCP — Tutorial",
    pages: { directory: "gcp/tutorial" },
  },
  {
    heading: "GCP — Compute",
    pages: { directory: "gcp/compute" },
  },
  {
    heading: "GCP — Frontend",
    pages: { directory: "gcp/frontend" },
  },
  {
    heading: "GCP — APIs",
    pages: { directory: "gcp/apis" },
  },
  {
    heading: "GCP — Data",
    pages: { directory: "gcp/data" },
  },
  {
    heading: "GCP — AI",
    pages: { directory: "gcp/ai" },
  },
  {
    heading: "GCP — Messaging & events",
    pages: { directory: "gcp/messaging" },
  },
  {
    heading: "GCP — Security & secrets",
    pages: { directory: "gcp/security" },
  },
  {
    heading: "GCP — Observability",
    pages: { directory: "gcp/observability" },
  },
  {
    heading: "GCP — Networking",
    pages: { directory: "gcp/networking" },
  },
  {
    heading: "Fly — start here",
    intro:
      "The Fly hub: overview (Apps, Machines, Services, Sprites), setup (org, API token, profile), and networking.",
    pages: {
      slugs: ["fly/index", "fly/setup", "fly/networking"],
    },
  },
  {
    heading: "Fly — Tutorial",
    pages: { directory: "fly/tutorial" },
  },
  {
    heading: "Fly — Compute",
    pages: { directory: "fly/compute" },
  },
  {
    heading: "Fly — Data",
    pages: { directory: "fly/data" },
  },
  {
    heading: "Fly — Frontend",
    pages: { directory: "fly/frontend" },
  },
  {
    heading: "Hetzner — start here",
    intro:
      "The Hetzner hub: overview (Servers and Services) and setup (project, API token, profile).",
    pages: {
      slugs: ["hetzner/index", "hetzner/setup"],
    },
  },
  {
    heading: "Hetzner — Tutorial",
    pages: { directory: "hetzner/tutorial" },
  },
  {
    heading: "Hetzner — Compute",
    pages: { directory: "hetzner/compute" },
  },
  {
    heading: "Hetzner — Data",
    pages: { directory: "hetzner/data" },
  },
  {
    heading: "Hetzner — Networking",
    pages: { directory: "hetzner/networking" },
  },
  {
    heading: "Hetzner — Frontend",
    pages: { directory: "hetzner/frontend" },
  },
  {
    heading: "Railway — start here",
    intro:
      "The Railway hub: overview (Projects, Services, databases), setup (workspace, API token, profile), and networking.",
    pages: {
      slugs: ["railway/index", "railway/setup", "railway/networking"],
    },
  },
  {
    heading: "Railway — Tutorial",
    pages: { directory: "railway/tutorial" },
  },
  {
    heading: "Railway — Compute",
    pages: { directory: "railway/compute" },
  },
  {
    heading: "Railway — Data",
    pages: { directory: "railway/data" },
  },
  {
    heading: "Railway — Frontend",
    pages: { directory: "railway/frontend" },
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
      "Neon backend resources: Postgres branches, Functions, private object storage, managed Auth, Data API, AI Gateway and Website adapters. The upload tutorial combines native and Effect handlers with authenticated browser uploads.",
    pages: {
      slugs: [
        "neon/index",
        "neon/setup",
        "neon/governance",
        "neon/guides/ai-gateway",
        "neon/guides/production-auth",
        "neon/guides/private-networking",
        "neon/guides/custom-domains",
        "neon/guides/state-recovery",
        "neon/tutorial/index",
        "neon/tutorial/backend",
        "neon/tutorial/functions",
        "neon/tutorial/frontend",
        "neon/tutorial/previews",
        "neon/data/branching",
        "neon/data/connections",
        "neon/data/roles",
        "neon/data/migrations",
        "neon/guides/preview-branches",
        "neon/guides/drizzle",
      ],
    },
  },
  {
    heading: "Neon — Frontend",
    pages: { directory: "neon/frontend" },
  },
  {
    heading: "Turso",
    intro:
      "Turso SQLite databases as Stack resources: groups, databases, migrations, connections, a database per tenant, preview databases, and scoped tokens.",
    pages: {
      slugs: [
        "turso/index",
        "turso/setup",
        "turso/tutorial/part-1",
        "turso/tutorial/part-2",
        "turso/tutorial/part-3",
        "turso/groups",
        "turso/databases",
        "turso/migrations",
        "turso/connections",
        "turso/database-per-tenant",
        "turso/preview-databases",
        "turso/tokens",
        "turso/organization",
      ],
    },
  },
  {
    heading: "Better Auth",
    intro:
      "Better Auth as an Effect service on Workers and Lambda: a tutorial, sign-in providers, database layers, and guides for config, middleware, secondary storage, migrations, and upgrades.",
    pages: { slugs: ["better-auth/index"] },
  },
  {
    heading: "Better Auth — Tutorial",
    pages: { directory: "better-auth/tutorial" },
  },
  {
    heading: "Better Auth — Sign-in providers",
    pages: { directory: "better-auth/sign-in-providers" },
  },
  {
    heading: "Better Auth — Databases",
    pages: { directory: "better-auth/databases" },
  },
  {
    heading: "Better Auth — Guides",
    pages: {
      slugs: [
        "better-auth/guides/configuration",
        "better-auth/guides/http-api-middleware",
        "better-auth/guides/secondary-storage",
        "better-auth/guides/migrations",
        "better-auth/upgrades/from-1-6-to-1-7",
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
    heading: "Git",
    intro:
      "A git server you build in one file, use like any remote, and reshape one block at a time: setup, a six-part tutorial (push, access control, publishing, per-user credentials, your app's API, branch protection), the REST and GitHub-compatible planes, the building blocks with their implementations, and recipes with the scaling model and measurements.",
    pages: {
      slugs: [
        "git/index",
        "git/getting-started",
        "git/tutorial/part-1",
        "git/tutorial/part-2",
        "git/tutorial/part-3",
        "git/tutorial/part-4",
        "git/tutorial/part-5",
        "git/tutorial/part-6",
        "git/clone-and-push",
        "git/repositories",
        "git/pull-requests",
        "git/github-api",
        "git/blocks/index",
        "git/blocks/server",
        "git/blocks/engine",
        "git/blocks/repositories",
        "git/blocks/registry",
        "git/blocks/blob-store",
        "git/blocks/hasher",
        "git/blocks/auth",
        "git/recipes/index",
        "git/recipes/scaling",
        "git/recipes/cloudflare",
        "git/recipes/cloudflare-aws",
        "git/recipes/your-own-store",
      ],
    },
  },
  {
    heading: "Stripe",
    intro:
      "Products, prices, coupons, customers, payment links, and webhooks as Stack resources. HTTP bindings run inside a Worker or Lambda.",
    pages: {
      slugs: [
        "stripe/index",
        "stripe/setup",
        "stripe/guides/subscriptions",
        "stripe/guides/connect",
        "stripe/guides/webhooks",
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
        "docker/swarm",
      ],
    },
  },
  {
    heading: "Kubernetes",
    intro:
      "Cluster-agnostic Kubernetes workloads — Deployments, Jobs and CronJobs (as images or Effect programs), raw manifests, and Helm charts — on a local cluster or any cluster reachable through a kubeconfig, token, client certificate, or exec plugin.",
    pages: {
      slugs: [
        "kubernetes/index",
        "kubernetes/setup",
        "kubernetes/tutorial/part-1",
        "kubernetes/tutorial/part-2",
        "kubernetes/tutorial/part-3",
        "kubernetes/tutorial/part-4",
        "kubernetes/tutorial/part-5",
        "kubernetes/clusters/connecting",
        "kubernetes/clusters/registries",
        "kubernetes/clusters/local",
        "kubernetes/clusters/eks",
        "kubernetes/clusters/cluster-adapters",
        "kubernetes/workloads/deployments",
        "kubernetes/workloads/jobs",
        "kubernetes/workloads/images",
        "kubernetes/workloads/bindings",
        "kubernetes/workloads/object-lifecycle",
        "kubernetes/objects/manifests",
        "kubernetes/objects/helm-charts",
      ],
    },
  },
  {
    heading: "SQL",
    intro:
      "Database comparison, Effect SQL, Drizzle, Prisma ORM v8 (Postgres-only), committed migrations, and connection lifecycle. Deployment walkthroughs live with their runtime providers.",
    pages: {
      slugs: [
        "sql/index",
        "sql/databases",
        "sql/effect-sql/postgres",
        "sql/effect-sql/mysql",
        "sql/effect-sql/d1",
        "sql/effect-sql/libsql",
        "sql/effect-sql/migrations",
        "sql/effect-sql/lifecycle",
        "sql/drizzle/postgres",
        "sql/drizzle/mysql",
        "sql/drizzle/d1",
        "sql/drizzle/libsql",
        "sql/drizzle/migrations",
        "sql/prisma/postgres",
        "sql/prisma/contracts",
        "sql/prisma/migrations",
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
  {
    heading: "ACME",
    intro:
      "TLS certificates from any ACME certificate authority as Stack resources, validated over DNS, renewed on deploy, or issued at runtime.",
    pages: {
      slugs: [
        "acme/index",
        "acme/getting-started",
        "acme/certificate-authorities",
        "acme/dns-validation",
        "acme/renewal",
        "acme/runtime",
        "acme/using-certificates",
        "acme/troubleshooting",
      ],
    },
  },
  {
    heading: "Domain",
    intro:
      "A domain-driven design framework: model commands, events, aggregates, views, projections, policies, and sagas once, then host them on Durable Objects or in memory.",
    pages: {
      slugs: [
        "domain/index",
        "domain/what-is-ddd",
        "domain/project-layout",
        "domain/tutorial/part-1",
        "domain/tutorial/part-2",
        "domain/tutorial/part-3",
        "domain/tutorial/part-4",
        "domain/tutorial/part-5",
        "domain/tutorial/part-6",
        "domain/tutorial/part-7",
        "domain/tutorial/part-8",
        "domain/model",
        "domain/command",
        "domain/event",
        "domain/aggregate",
        "domain/view",
        "domain/projection",
        "domain/stream",
        "domain/policy",
        "domain/saga",
        "domain/external-system",
        "domain/api",
        "domain/story",
        "domain/testing-models",
        "domain/testing-apis",
        "domain/foldkit",
        "domain/optimistic-updates",
        "domain/local-first",
        "domain/mcp",
        "domain/sessions",
        "domain/better-auth",
        "domain/view-security",
        "domain/unique-values",
        "domain/deadlines",
        "domain/cloudflare",
        "domain/backfill",
        "domain/in-memory",
        "domain/http-api",
        "domain/cli",
        "domain/observability",
      ],
    },
  },
];

const PROVIDERS_INTRO_BASE = `Service-level API reference, generated from JSDoc on the source \`.ts\` files via \`bun scripts/generate-api-reference.ts\`. Each page groups resources and capabilities by service, with a heading per resource and examples extracted from source JSDoc.`;

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

This file is a navigation index for the documentation site at ${siteUrl}. Guide and concept pages are listed below with their URL and a one-line summary, so an agent can pick the right page in one hop. The service-level API reference is indexed separately in [llms-full.txt](${siteUrl}/llms-full.txt).`;

const FULL_HEADER = `# Alchemy

> Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that combines cloud infrastructure and application logic into a single, type-safe program powered by [Effect](https://effect.website). Resources are declared as Effects; bindings wire IAM, env vars, and typed SDKs in one call; deploys and runtime share the same code.

This file is a navigation index for the documentation site at ${siteUrl}. Every page under \`/src/content/docs/\` is listed below with its URL and a one-line summary, so an agent can pick the right page in one hop. This is the full index including every service-level API reference page; the smaller [llms.txt](${siteUrl}/llms.txt) covers just the guides and concept docs.`;

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
      // Dev-generated reference pages carry copy-editor markers.
      const source = (await readFile(full, "utf8")).replace(
        /<!--copy:[^>]*?-->|^<div data-copy=[^\n]*>\n|^<\/div><!--\/copy-->\n/gm,
        "",
      );
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

async function listSlugs(directory: string, exclude: string[] = []): Promise<string[]> {
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

/**
 * Fails when a published page is missing from SECTIONS or listed twice, so
 * a new docs page can never silently drop out of llms.txt. The generated
 * API reference (`providers/`) and the blog are indexed separately.
 */
async function assertCoverage(listed: string[]) {
  const counts = new Map<string, number>();
  for (const slug of listed) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([slug]) => slug);

  const entries = await readdir(docsDir, { withFileTypes: true });
  const published: string[] = [];
  for (const entry of entries) {
    if (entry.name === "providers" || entry.name === "blog") continue;
    const slugs = entry.isDirectory()
      ? await listSlugs(entry.name)
      : [".md", ".mdx"].includes(path.extname(entry.name))
        ? [entry.name.slice(0, -path.extname(entry.name).length)]
        : [];
    for (const page of await Promise.all(slugs.map(loadPage))) {
      if (!page.draft) published.push(page.slug);
    }
  }
  const missing = published.filter((slug) => !counts.has(slug));

  const problems = [
    ...missing.map((slug) => `not listed in any SECTIONS entry: ${slug}`),
    ...duplicates.map((slug) => `listed in more than one SECTIONS entry: ${slug}`),
  ];
  if (problems.length > 0) {
    throw new Error(
      `llms.txt does not match the docs:\n  ${problems.join("\n  ")}\n` +
        `Add each page to a section in scripts/generate-llms-txt.ts.`,
    );
  }
}

async function main() {
  const sections: string[] = [];
  const listed: string[] = [];

  for (const section of SECTIONS) {
    const isDirectory = !("slugs" in section.pages);
    const slugs =
      "slugs" in section.pages
        ? section.pages.slugs
        : await listSlugs(section.pages.directory, section.pages.exclude);
    listed.push(...slugs);
    const pages = (await Promise.all(slugs.map(loadPage))).filter((p) => !p.draft);
    // Directory sections mirror the sidebar's `sidebar.order` ordering; slug
    // sections keep the curated order they were declared in.
    if (isDirectory) pages.sort(byOrderThenTitle);

    sections.push(`## ${section.heading}`);
    if (section.intro) sections.push(section.intro);
    sections.push(pages.map(renderPage).join("\n"));
  }

  await assertCoverage(listed);

  const fullBody = [FULL_HEADER, ...sections, await renderProvidersSection()].join("\n\n") + "\n";
  await writeFile(outFullFile, fullBody, "utf8");
  console.log(`Wrote ${outFullFile}`);

  const fullSizeKb = Math.round(Buffer.byteLength(fullBody, "utf8") / 1024);
  const referenceSection = [
    `## API reference`,
    `${PROVIDERS_INTRO_BASE}\n\nThe service-level pages are indexed in [llms-full.txt](${siteUrl}/llms-full.txt), which repeats this entire file plus one link per service. Warning: it is large (~${fullSizeKb} KB) — only fetch it when you need to locate a specific resource's reference page.`,
  ];

  const body = [HEADER, ...sections, ...referenceSection].join("\n\n") + "\n";
  await writeFile(outFile, body, "utf8");
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
