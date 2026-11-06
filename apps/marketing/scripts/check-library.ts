// Checks the /learn library: every map entry has a page, every page has a map entry, and the
// internal link graph has no broken links, no orphans, and reciprocal coverage.
// Usage: node scripts/check-library.ts [--json]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { CLUSTERS, ENTRIES, entryKey, relatedTo } from "../src/lib/library.ts";

const ROOT = NodeURL.fileURLToPath(new URL("../src/content/library", import.meta.url));
const SITE_PATHS = new Set([
  "/",
  "/download",
  "/learn",
  "/legal",
  "/privacy-policy",
  "/security-policy",
  "/terms-of-service",
]);
const MIN_WORDS = { hub: 150, pillar: 350, page: 600, video: 900 } as const;
const MIN_OUT = 4;
const MIN_IN = 2;
// Phrases that read as filler or that the site's voice does not use.
const BANNED = [
  /—/,
  /\bdelve\b/i,
  /\bseamless(ly)?\b/i,
  /\bunleash\b/i,
  /\bgame[- ]changer\b/i,
  /\bin today's\b/i,
  /\bit's worth noting\b/i,
  /\brobust\b/i,
  /\bleverage\b/i,
  /\bsupercharge\b/i,
];

type Kind = keyof typeof MIN_WORDS;
interface Page {
  key: string;
  kind: Kind;
  cluster: string;
  file: string;
  title: string;
  description: string;
  body: string;
  links: string[];
}

const walk = (dir: string): string[] =>
  NodeFS.readdirSync(dir).flatMap((name) => {
    const full = NodePath.join(dir, name);
    return NodeFS.statSync(full).isDirectory() ? walk(full) : name.endsWith(".md") ? [full] : [];
  });

const field = (front: string, name: string): string => {
  const match = front.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return match ? match[1]!.trim().replace(/^["']|["']$/g, "") : "";
};

const pages: Page[] = NodeFS.existsSync(ROOT)
  ? walk(ROOT).map((file) => {
      const raw = NodeFS.readFileSync(file, "utf8");
      const [, front = "", body = ""] = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/) ?? [];
      const rel = NodePath.relative(ROOT, file).replace(/\.md$/, "");
      const parts = rel.split("/");
      const kind: Kind =
        rel === "index"
          ? "hub"
          : parts[1] === "index"
            ? "pillar"
            : parts[0] === "videos"
              ? "video"
              : "page";
      const key = kind === "hub" ? "" : kind === "pillar" ? parts[0]! : rel;
      const links = [...body.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((m) => m[1]!);
      return {
        key,
        kind,
        cluster: parts.length > 1 ? parts[0]! : "",
        file: NodePath.relative(process.cwd(), file),
        title: field(front, "title"),
        description: field(front, "description"),
        body,
        links,
      };
    })
  : [];

const errors: string[] = [];
const warnings: string[] = [];
const byKey = new Map(pages.map((page) => [page.key, page]));
const known = new Set([...ENTRIES.map(entryKey), ...CLUSTERS.map((c) => c.id)]);
const learnKey = (path: string): string | undefined =>
  path.startsWith("/learn/") ? path.slice("/learn/".length) : undefined;

if (!byKey.has("")) errors.push("missing hub src/content/library/index.md");
for (const cluster of CLUSTERS)
  if (!byKey.has(cluster.id)) errors.push(`missing pillar ${cluster.id}/index.md`);
for (const entry of ENTRIES)
  if (!byKey.has(entryKey(entry))) errors.push(`missing page ${entryKey(entry)}.md`);
for (const page of pages)
  if (page.key && !known.has(page.key)) errors.push(`${page.file}: not in src/lib/library.ts`);

const inbound = new Map<string, Set<string>>();
for (const page of pages) {
  const words = page.body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
  if (words < MIN_WORDS[page.kind])
    errors.push(`${page.file}: ${words} words, needs ${MIN_WORDS[page.kind]}`);
  if (!page.title) errors.push(`${page.file}: no title`);
  if (page.description.length < 110 || page.description.length > 165)
    errors.push(`${page.file}: description is ${page.description.length} chars, needs 110-165`);
  if (/^#\s/m.test(page.body))
    errors.push(`${page.file}: has an H1; the layout renders the title as H1`);
  for (const pattern of BANNED)
    if (pattern.test(page.body) || pattern.test(page.description))
      errors.push(`${page.file}: banned phrase ${pattern}`);

  const targets = new Set<string>();
  for (const link of page.links) {
    if (link.length > 1 && link.endsWith("/"))
      errors.push(`${page.file}: trailing slash in ${link}`);
    const key = learnKey(link);
    if (key === undefined) {
      if (!SITE_PATHS.has(link)) errors.push(`${page.file}: unknown site link ${link}`);
      continue;
    }
    if (!known.has(key)) errors.push(`${page.file}: broken link ${link}`);
    else if (key !== page.key) {
      targets.add(key);
      if (!inbound.has(key)) inbound.set(key, new Set());
      inbound.get(key)!.add(page.key || "hub");
    }
  }

  if (page.kind === "hub") {
    for (const cluster of CLUSTERS)
      if (!targets.has(cluster.id))
        errors.push(`${page.file}: hub must link pillar /learn/${cluster.id}`);
    continue;
  }
  if (page.kind === "pillar") {
    for (const entry of ENTRIES.filter((e) => e.cluster === page.key)) {
      if (!targets.has(entryKey(entry)))
        errors.push(`${page.file}: pillar must link child /learn/${entryKey(entry)}`);
    }
    continue;
  }
  const library = [...targets].filter((k) => k !== page.cluster);
  if (library.length < MIN_OUT)
    errors.push(`${page.file}: ${library.length} in-body library links, needs ${MIN_OUT}`);
  if (!targets.has(page.cluster))
    errors.push(`${page.file}: must link its pillar /learn/${page.cluster}`);
  if (!library.some((k) => !k.startsWith(`${page.cluster}/`) && k.includes("/")))
    errors.push(`${page.file}: needs one link outside its cluster`);
  for (const rel of relatedTo(page.key)) {
    const relKey = entryKey(rel);
    if (!targets.has(relKey))
      warnings.push(`${page.file}: related page ${relKey} has no in-body link`);
  }
}

// Reciprocity: a page that links A from its body should be linked back by A, inside the same cluster.
for (const page of pages.filter((p) => p.kind === "page" || p.kind === "video")) {
  const count = inbound.get(page.key)?.size ?? 0;
  if (count < MIN_IN) errors.push(`${page.file}: ${count} inbound in-body links, needs ${MIN_IN}`);
  for (const link of page.links) {
    const key = learnKey(link);
    const target = key ? byKey.get(key) : undefined;
    if (
      target &&
      target.cluster === page.cluster &&
      (target.kind === "page" || target.kind === "video") &&
      !target.links.includes(`/learn/${page.key}`)
    ) {
      warnings.push(`${page.file}: links ${key} but ${key} does not link back`);
    }
  }
}

const summary = {
  pages: pages.length,
  expected: ENTRIES.length + CLUSTERS.length + 1,
  errors: errors.length,
  warnings: warnings.length,
};
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, errors, warnings }, null, 2));
} else {
  for (const line of errors) console.log(`error  ${line}`);
  for (const line of warnings) console.log(`warn   ${line}`);
  console.log(
    `\n${summary.pages}/${summary.expected} pages, ${summary.errors} errors, ${summary.warnings} warnings`,
  );
}
process.exitCode = errors.length ? 1 : 0;
