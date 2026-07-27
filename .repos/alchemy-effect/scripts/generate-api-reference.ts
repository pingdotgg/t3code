import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Node, Project, type SourceFile } from "ts-morph";

const websiteRoot = path.join(import.meta.dir, "../website");

const config = {
  srcRoot: path.join(import.meta.dir, "../packages/alchemy/src"),
  outRoot: path.join(websiteRoot, "src/content/docs/providers"),
  tsConfig: path.join(import.meta.dir, "../packages/alchemy/tsconfig.json"),
};

interface FileEntry {
  relativePath: string;
  absolutePath: string;
}

interface ExampleBlock {
  title: string;
  body: string;
}

interface ExampleSection {
  title: string;
  description: string;
  examples: ExampleBlock[];
}

interface PageDoc {
  title: string;
  relativePath: string;
  summary: string;
  sections: ExampleSection[];
}

const normalizeSlashes = (value: string) => value.split(path.sep).join("/");

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  const topLevelEntries = await fs.readdir(config.srcRoot, {
    withFileTypes: true,
  });
  const dirs = topLevelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const dir of dirs) {
    const dirPath = path.join(config.srcRoot, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      const baseName = path.basename(file);
      if (!baseName.endsWith(".ts") && !baseName.endsWith(".tsx")) continue;
      if (baseName.endsWith(".d.ts")) continue;
      if (baseName === "index.ts") continue;

      const relativePath = path.join(dir, file);
      entries.push({
        relativePath,
        absolutePath: path.join(config.srcRoot, relativePath),
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function getJsDocText(node: Node): string {
  const getter = (node as Node & { getJsDocs?: () => { getText(): string }[] })
    .getJsDocs;
  if (!getter) return "";
  return getter
    .call(node)
    .map((doc) => doc.getText())
    .join("\n");
}

function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

interface ParsedJSDoc {
  summary: string;
  sections: ExampleSection[];
  hasResourceTag: boolean;
  hasBindingTag: boolean;
  category: string;
  product: string;
}

function parseJSDoc(node: Node): ParsedJSDoc {
  const raw = getJsDocText(node);
  if (!raw) {
    return {
      summary: "",
      sections: [],
      hasResourceTag: false,
      hasBindingTag: false,
      category: "",
      product: "",
    };
  }

  const lines = cleanDocComment(raw).split("\n");

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  let hasResourceTag = false;
  let hasBindingTag = false;
  let category = "";
  let product = "";
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleBlock | undefined;

  let sectionDescLines: string[] = [];
  let collectingSectionDesc = false;
  let insideFence = false;

  const flushExample = () => {
    if (!currentExample) return;
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = { title: "Examples", description: "", examples: [] };
      sections.push(currentSection);
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  const flushSectionDesc = () => {
    if (currentSection && sectionDescLines.length > 0) {
      currentSection.description = sectionDescLines.join("\n").trim();
    }
    sectionDescLines = [];
    collectingSectionDesc = false;
  };

  for (const line of lines) {
    // Track fenced code blocks so an `@`-prefixed line inside an example
    // (e.g. a decorator) is never mistaken for a JSDoc tag.
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
    }

    const tag = insideFence ? null : line.trim().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = (rest ?? "").trim();
      switch (name) {
        case "resource":
          hasResourceTag = true;
          break;
        case "binding":
          hasBindingTag = true;
          break;
        case "category":
        case "group":
          if (value) category = value;
          break;
        case "product":
        case "label":
          if (value) product = value;
          break;
        case "section":
          flushExample();
          flushSectionDesc();
          currentSection = {
            title: value || "Examples",
            description: "",
            examples: [],
          };
          sections.push(currentSection);
          collectingSectionDesc = true;
          break;
        case "example":
          flushSectionDesc();
          flushExample();
          currentExample = { title: value || "Example", body: "" };
          break;
      }
      continue;
    }

    if (!sawTag) {
      summaryLines.push(line);
      continue;
    }

    if (currentExample) {
      currentExample.body += `${line}\n`;
    } else if (collectingSectionDesc) {
      sectionDescLines.push(line);
    }
  }

  flushSectionDesc();
  flushExample();

  return {
    summary: summaryLines.join("\n").trim(),
    sections,
    hasResourceTag,
    hasBindingTag,
    category,
    product,
  };
}

function declName(node: Node): string {
  if (Node.isVariableStatement(node)) {
    return node.getDeclarations()[0]?.getName() ?? "";
  }
  if (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node)
  ) {
    return node.getName() ?? "";
  }
  return "";
}

interface Primary {
  name: string;
  doc: ParsedJSDoc;
  category: string;
  product: string;
}

const hasContent = (doc: ParsedJSDoc) =>
  Boolean(doc.summary) || doc.sections.length > 0;

/**
 * Map a public export name back to its local declaration name when a file
 * re-exports under an alias, e.g. `export { VpcLinkResource as VpcLink }`
 * lets us find the documented `VpcLinkResource` const from the tagged
 * `VpcLink` interface.
 */
function localNameForExport(
  sourceFile: SourceFile,
  publicName: string,
): string | undefined {
  for (const ed of sourceFile.getExportDeclarations()) {
    if (ed.getModuleSpecifier()) continue;
    for (const spec of ed.getNamedExports()) {
      if (spec.getAliasNode()?.getText() === publicName) {
        return spec.getNameNode().getText();
      }
    }
  }
  return undefined;
}

/**
 * The page for a file is owned by the single exported declaration tagged
 * `@resource` or `@binding`, and named after it. Authors sometimes write the
 * docs (summary/@section/@example) on a sibling declaration of the same name
 * (an `interface X` paired with `const X`) or on an internal const that is
 * re-exported under the tagged name (the ApiGateway `XResource as X` pattern).
 * When the tagged declaration itself has no content, pull it from that related
 * declaration so the page isn't dropped as empty.
 */
function findTaggedPrimary(sourceFile: SourceFile): Primary | undefined {
  const candidates: Node[] = [
    ...sourceFile.getVariableStatements().filter((s) => s.isExported()),
    ...sourceFile.getClasses().filter((c) => c.isExported()),
    ...sourceFile.getInterfaces().filter((i) => i.isExported()),
  ];

  for (const node of candidates) {
    const doc = parseJSDoc(node);
    if (!doc.hasResourceTag && !doc.hasBindingTag) continue;
    const name = declName(node);
    if (!name) continue;
    const category = doc.category;
    const product = doc.product;
    if (hasContent(doc)) return { name, doc, category, product };

    // Tagged declaration has no prose — look for the related declaration that
    // carries the docs (same name, or re-exported under this name).
    const localName = localNameForExport(sourceFile, name);
    const related: Node[] = [
      ...sourceFile.getVariableStatements(),
      ...sourceFile.getClasses(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
    ].filter((d) => {
      if (d === node) return false;
      const dn = declName(d);
      return dn === name || (localName !== undefined && dn === localName);
    });

    let best: ParsedJSDoc | undefined;
    for (const d of related) {
      const pd = parseJSDoc(d);
      if (pd.sections.length > 0) {
        best = pd;
        break;
      }
      if (!best && pd.summary) best = pd;
    }
    return { name, doc: best ?? doc, category, product };
  }
  return undefined;
}

const LINK_TAG_RE = /\{@link\s+([^}]+)\}/g;

/** Split a `{@link ...}` tag's inner text into target + optional label. */
function parseLinkTag(inner: string): { target: string; label?: string } {
  const trimmed = inner.trim();
  const pipe = trimmed.indexOf("|");
  if (pipe !== -1) {
    return {
      target: trimmed.slice(0, pipe).trim(),
      label: trimmed.slice(pipe + 1).trim() || undefined,
    };
  }
  const space = trimmed.search(/\s/);
  if (space !== -1) {
    return {
      target: trimmed.slice(0, space).trim(),
      label: trimmed.slice(space + 1).trim() || undefined,
    };
  }
  return { target: trimmed };
}

/**
 * Reduce a typedoc-style `import("./Secrets.ts").Secrets` target to the bare
 * symbol name — resolution (same-directory first) and display both want the
 * name, not the module expression.
 */
function normalizeLinkTarget(target: string): string {
  const match = target.match(/^import\((["'])[^"']+\1\)\.(.+)$/);
  return match ? match[2] : target;
}

/** Resolves a `{@link}` symbol target to a generated page URL, if any. */
type LinkResolver = (target: string) => string | undefined;

/**
 * Build a per-page resolver factory. A symbol resolves to another generated
 * page preferring (in order): a same-directory page named after it, a
 * same-directory page whose source file exports it (an access-level service
 * like `ReadNamespace` documented on its `ReadWriteNamespace` page), a unique
 * name match within the same provider, a unique exporter within the same
 * provider, then a unique global name match. Member suffixes
 * (`Cluster#capacityProviders`), provider-qualified names (`Cloudflare.Worker`)
 * and `FooProps` interfaces resolve to the base resource's page.
 */
function makeLinkResolverFactory(
  pages: PageEntry[],
): (fromDir: string) => LinkResolver {
  const byName = new Map<string, PageEntry[]>();
  const byExport = new Map<string, PageEntry[]>();
  for (const p of pages) {
    if (!byName.has(p.resource)) byName.set(p.resource, []);
    byName.get(p.resource)!.push(p);
    for (const name of p.exports) {
      if (!byExport.has(name)) byExport.set(name, []);
      byExport.get(name)!.push(p);
    }
  }
  const providers = new Set(pages.map((p) => p.provider));

  return (fromDir: string) => {
    const fromProvider = fromDir.split("/")[0] ?? "";

    const lookup = (
      name: string,
      provider?: string,
    ): PageEntry | undefined => {
      const scope = (list: PageEntry[] | undefined) =>
        (list ?? []).filter((c) => !provider || c.provider === provider);
      const named = scope(byName.get(name));
      const exporting = scope(byExport.get(name));

      const sameDirNamed = named.filter((c) => c.dir === fromDir);
      if (sameDirNamed.length === 1) return sameDirNamed[0];
      const sameDirExporting = exporting.filter((c) => c.dir === fromDir);
      if (sameDirExporting.length === 1) return sameDirExporting[0];
      const providerNamed = named.filter((c) => c.provider === fromProvider);
      if (providerNamed.length === 1) return providerNamed[0];
      const providerExporting = exporting.filter(
        (c) => c.provider === fromProvider,
      );
      if (providerExporting.length === 1) return providerExporting[0];
      if (named.length === 1) return named[0];
      return undefined;
    };

    return (target: string) => {
      // Strip a `#member` suffix — the link lands on the owning resource page.
      const base = target.split("#")[0];

      const attempts: { name: string; provider?: string }[] = [{ name: base }];
      if (base.includes(".")) {
        const segments = base.split(".");
        const first = segments[0];
        const last = segments[segments.length - 1];
        if (providers.has(first)) {
          // Provider-qualified: `Cloudflare.Worker`, `Cloudflare.KV.Namespace`.
          attempts.push({ name: last, provider: first });
        } else {
          // Member access on a symbol: `KeyPairProps.publicKeyMaterial`.
          attempts.push({ name: first });
          if (first.endsWith("Props")) {
            attempts.push({ name: first.slice(0, -"Props".length) });
          }
        }
      } else if (base.endsWith("Props")) {
        attempts.push({ name: base.slice(0, -"Props".length) });
      }

      for (const attempt of attempts) {
        const found = lookup(attempt.name, attempt.provider);
        if (found) return found.link;
      }
      return undefined;
    };
  };
}

const isUrl = (target: string) => /^https?:\/\//.test(target);

/**
 * Replace `{@link ...}` tags with markdown links, skipping fenced code
 * blocks. Symbols that don't resolve to a generated page render as inline
 * code (or their label) instead of leaking the raw tag.
 */
/** Symbol targets that didn't resolve to a page, for the end-of-run summary. */
const unresolvedLinkTargets = new Map<string, number>();

function linkifyMarkdown(markdown: string, resolve: LinkResolver): string {
  const replaceTags = (chunk: string) =>
    chunk.replace(LINK_TAG_RE, (_, inner: string) => {
      // A tag wrapped across source lines carries the line break in its
      // label — collapse it so the markdown link stays intact.
      const parsed = parseLinkTag(inner.replace(/\s+/g, " "));
      const label = parsed.label;
      if (isUrl(parsed.target)) {
        return `[${label ?? parsed.target}](${parsed.target})`;
      }
      const target = normalizeLinkTarget(parsed.target);
      const url = resolve(target);
      if (!url) {
        unresolvedLinkTargets.set(
          target,
          (unresolvedLinkTargets.get(target) ?? 0) + 1,
        );
      }
      const text = label ?? `\`${target}\``;
      return url ? `[${text}](${url})` : text;
    });

  // Apply across contiguous non-fence chunks (a `{@link}` may span lines);
  // leave fenced code blocks untouched.
  const out: string[] = [];
  let chunk: string[] = [];
  let insideFence = false;
  const flushChunk = () => {
    if (chunk.length > 0) {
      out.push(replaceTags(chunk.join("\n")));
      chunk = [];
    }
  };
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (!insideFence) flushChunk();
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
    } else {
      chunk.push(line);
    }
  }
  flushChunk();
  return out.join("\n");
}

/** Reduce `{@link ...}` tags to plain text for frontmatter descriptions. */
function stripLinkTags(text: string): string {
  return text.replace(LINK_TAG_RE, (_, inner: string) => {
    const { target, label } = parseLinkTag(inner.replace(/\s+/g, " "));
    return (label ?? normalizeLinkTarget(target)).replace(/`/g, "");
  });
}

function yamlString(value: string): string {
  if (/[\n:"{}[\],&*?|>!%@`#]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function firstParagraph(value: string): string {
  const idx = value.indexOf("\n\n");
  const para = idx === -1 ? value : value.slice(0, idx);
  return para.replace(/\s+/g, " ").trim();
}

function renderPageBody(doc: PageDoc): string {
  const parts: string[] = [];

  if (doc.summary) {
    parts.push(doc.summary);
  }

  for (const section of doc.sections) {
    const secParts = [`## ${section.title}`];
    if (section.description) {
      secParts.push(section.description);
    }
    for (const example of section.examples) {
      if (section.examples.length > 1) {
        secParts.push(`**${example.title}**`);
      }
      secParts.push(example.body);
    }
    parts.push(secParts.join("\n\n"));
  }

  return parts.join("\n\n");
}

function renderPage(doc: PageDoc, resolve: LinkResolver): string {
  const sourcePath = `src/${normalizeSlashes(doc.relativePath)}`;
  const description =
    stripLinkTags(firstParagraph(doc.summary)) ||
    `API reference for ${doc.title}`;
  const frontmatter = [
    "---",
    `title: ${yamlString(doc.title)}`,
    `description: ${yamlString(description)}`,
    "---",
  ].join("\n");

  const sourceBlock = `> **Source:** \`${sourcePath}\``;
  const body = linkifyMarkdown(renderPageBody(doc).trim(), resolve);

  if (body) {
    return `${frontmatter}\n\n${sourceBlock}\n\n${body}\n`;
  }
  return `${frontmatter}\n\n${sourceBlock}\n`;
}

/** Providers shown first in the sidebar; the rest follow alphabetically. */
const PROVIDER_ORDER = ["AWS", "Cloudflare"];

/**
 * Uncategorized providers with at most this many pages render as a flat
 * resource list instead of per-service folders (see buildProvidersSidebar).
 */
const FLAT_PROVIDER_MAX_PAGES = 16;

interface SidebarLeaf {
  label: string;
  link: string;
}
interface SidebarGroup {
  label: string;
  collapsed: true;
  items: SidebarItem[];
}
type SidebarItem = SidebarLeaf | SidebarGroup;

interface PageEntry {
  provider: string;
  service: string;
  resource: string;
  category: string;
  product: string;
  link: string;
  /** Source directory relative to srcRoot (slash-normalized), e.g. `Cloudflare/KV`. */
  dir: string;
  /** All names the page's source file exports — `{@link}` targets documented on this page. */
  exports: string[];
}

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label);

function orderedKeys(keys: string[], order: string[]): string[] {
  const ranked = keys.filter((k) => order.includes(k));
  ranked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = keys.filter((k) => !order.includes(k)).sort();
  return [...ranked, ...rest];
}

/**
 * Build sidebar items for one set of pages sharing a provider+category:
 * every product is its own collapsible folder containing its resource
 * pages, mirroring how Cloudflare's API reference gives each product its
 * own section — even single-page products like D1 or Organization — so
 * the grouping is uniform.
 *
 * Grouping is by resolved product LABEL (`@product`, falling back to the
 * service dir name), not by directory: two directories declaring the same
 * product merge into one group instead of rendering duplicate siblings.
 */
function buildServiceItems(pages: PageEntry[]): SidebarItem[] {
  const byLabelKey = new Map<string, PageEntry[]>();
  for (const p of pages) {
    const key = p.product || p.service || p.resource;
    if (!byLabelKey.has(key)) byLabelKey.set(key, []);
    byLabelKey.get(key)!.push(p);
  }
  const items: SidebarItem[] = [];
  for (const [label, productPages] of byLabelKey) {
    items.push({
      label,
      collapsed: true,
      items: productPages
        .map((p) => ({ label: p.resource, link: p.link }))
        .sort(byLabel),
    });
  }
  return items.sort(byLabel);
}

function buildProvidersSidebar(entries: PageEntry[]): SidebarItem[] {
  const byProvider = new Map<string, PageEntry[]>();
  for (const e of entries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push(e);
  }

  const providers: SidebarGroup[] = [];
  for (const provider of orderedKeys([...byProvider.keys()], PROVIDER_ORDER)) {
    const pages = byProvider.get(provider)!;

    // `@category` is per-file; a documented file that omits it must not fall
    // out of its service's category and render a duplicate service group at
    // the provider root. Inherit the category any sibling page of the same
    // service dir declares.
    const categoryByService = new Map<string, string>();
    for (const p of pages) {
      if (p.service && p.category && !categoryByService.has(p.service)) {
        categoryByService.set(p.service, p.category);
      }
    }

    const categorized = new Map<string, PageEntry[]>();
    const uncategorized: PageEntry[] = [];
    for (const p of pages) {
      const category = p.category || categoryByService.get(p.service) || "";
      if (category) {
        if (!categorized.has(category)) categorized.set(category, []);
        categorized.get(category)!.push(p);
      } else {
        uncategorized.push(p);
      }
    }

    const items: SidebarItem[] = [];
    for (const cat of [...categorized.keys()].sort((a, b) =>
      a.localeCompare(b),
    )) {
      items.push({
        label: cat,
        collapsed: true,
        items: buildServiceItems(categorized.get(cat)!),
      });
    }
    if (categorized.size === 0 && pages.length <= FLAT_PROVIDER_MAX_PAGES) {
      // Small uncategorized providers (Neon, Planetscale, Axiom, GitHub, …)
      // render as a flat resource list — per-service folders around one or
      // two pages ("Branch > Branch") are redundant nesting, and prefixed
      // resource names (MySQLBranch/PostgresBranch) already carry the
      // grouping information.
      items.push(
        ...uncategorized
          .map((p) => ({ label: p.resource, link: p.link }))
          .sort(byLabel),
      );
    } else {
      // Pages without a category fall back to service grouping directly under
      // the provider (this is how AWS renders until it gets categorized).
      items.push(...buildServiceItems(uncategorized));
    }

    providers.push({ label: provider, collapsed: true, items });
  }

  assertNoDuplicateSiblings(providers, []);
  return providers;
}

/**
 * Duplicate sibling labels are always a tagging bug (e.g. two products
 * resolving to the same name in one category) and render as confusing
 * twin sections — fail the generation instead of shipping them.
 */
function assertNoDuplicateSiblings(items: SidebarItem[], path: string[]) {
  const seen = new Map<string, number>();
  for (const item of items) {
    seen.set(item.label, (seen.get(item.label) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  if (dups.length > 0) {
    throw new Error(
      `Duplicate sidebar sibling label(s) under "${path.join(" > ") || "(root)"}": ${dups
        .map(([label, n]) => `"${label}" ×${n}`)
        .join(", ")} — fix the @product/@category tags on the offending files.`,
    );
  }
  for (const item of items) {
    if ("items" in item) {
      assertNoDuplicateSiblings(item.items, [...path, item.label]);
    }
  }
}

async function main() {
  const entries = await discoverFiles();
  console.log(`Discovered ${entries.length} source files.`);

  const project = new Project({
    tsConfigFilePath: config.tsConfig,
    skipFileDependencyResolution: true,
  });

  await fs.rm(config.outRoot, { recursive: true, force: true });
  await fs.mkdir(config.outRoot, { recursive: true });

  const seen = new Map<string, string>();
  const pageEntries: PageEntry[] = [];
  const pending: { outputRelative: string; doc: PageDoc }[] = [];
  let written = 0;
  let skipped = 0;

  for (const entry of entries) {
    const sourceFile = project.getSourceFile(entry.absolutePath);
    if (!sourceFile) {
      console.warn(`  skipped (not in project): ${entry.relativePath}`);
      skipped++;
      continue;
    }

    const primary = findTaggedPrimary(sourceFile);
    if (!primary) {
      skipped++;
      continue;
    }

    // Only emit a page when there's actual documented content; a bare
    // frontmatter + source link stub is noise.
    if (!primary.doc.summary && primary.doc.sections.length === 0) {
      skipped++;
      continue;
    }

    // Mirror the source directory structure; name the page after the
    // tagged declaration (e.g. Cloudflare.AI.Search/AiSearchInstance.md).
    const relDir = path.dirname(entry.relativePath);
    const outputRelative = path.join(relDir, `${primary.name}.md`);

    const existing = seen.get(outputRelative);
    if (existing) {
      console.warn(
        `  collision: ${outputRelative} from ${entry.relativePath} (already from ${existing})`,
      );
    }
    seen.set(outputRelative, entry.relativePath);

    const doc: PageDoc = {
      title: primary.name,
      relativePath: entry.relativePath,
      summary: primary.doc.summary,
      sections: primary.doc.sections,
    };
    pending.push({ outputRelative, doc });

    let exportNames: string[] = [];
    try {
      exportNames = [...sourceFile.getExportedDeclarations().keys()];
    } catch {
      // Unresolvable re-exports — page-name resolution still applies.
    }

    const segments = normalizeSlashes(outputRelative).split("/");
    pageEntries.push({
      provider: segments[0] ?? "",
      service: segments.length > 2 ? segments[1] : "",
      resource: primary.name,
      category: primary.category,
      product: primary.product,
      link: `/providers/${normalizeSlashes(outputRelative)
        .replace(/\.md$/, "")
        .toLowerCase()}`,
      dir: normalizeSlashes(relDir),
      exports: exportNames,
    });
  }

  // Second pass: render with `{@link}` resolution — the full page set must be
  // known before symbol targets can resolve to their pages.
  const resolverFor = makeLinkResolverFactory(pageEntries);
  for (const page of pending) {
    const resolve = resolverFor(
      normalizeSlashes(path.dirname(page.outputRelative)),
    );
    const outputPath = path.join(config.outRoot, page.outputRelative);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, renderPage(page.doc, resolve), "utf8");
    written++;
  }

  const sidebar = buildProvidersSidebar(pageEntries);

  // Landing page for the Reference tab (/providers): a provider directory.
  // Each provider's reference belongs to its docs hub — the directory just
  // routes there (or into the tree, for providers without a hub). The
  // ProviderDirectory component reads the generated sidebar for counts.
  // Regenerated with the rest of the tree on every run.
  const referenceIndex = [
    "---",
    "title: API Reference",
    "description: Every provider alchemy can manage — pick a provider to open its docs hub and resource reference.",
    "---",
    "",
    'import ProviderDirectory from "../../../components/ProviderDirectory.astro";',
    "",
    "Every resource alchemy can manage, documented from the source JSDoc and",
    "organized by provider. A provider's reference lives in its docs hub —",
    "pick one below, or search with `⌘K`.",
    "",
    "<ProviderDirectory />",
    "",
  ].join("\n");
  await fs.rm(path.join(config.outRoot, "index.md"), { force: true });
  await fs.writeFile(
    path.join(config.outRoot, "index.mdx"),
    referenceIndex,
    "utf8",
  );

  const sidebarPath = path.join(
    websiteRoot,
    "src/generated/providers-sidebar.json",
  );
  await fs.mkdir(path.dirname(sidebarPath), { recursive: true });
  await fs.writeFile(
    sidebarPath,
    `${JSON.stringify(sidebar, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Done. Wrote ${written} resource pages (skipped ${skipped} untagged) to ${normalizeSlashes(
      path.relative(path.join(import.meta.dir, ".."), config.outRoot),
    )}.`,
  );
  if (unresolvedLinkTargets.size > 0) {
    const list = [...unresolvedLinkTargets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([target, n]) => (n > 1 ? `${target} ×${n}` : target))
      .join(", ");
    console.log(
      `{@link} targets without a page (rendered as inline code): ${list}`,
    );
  }
  console.log(
    `Wrote provider sidebar to ${normalizeSlashes(
      path.relative(path.join(import.meta.dir, ".."), sidebarPath),
    )}.`,
  );
}

await main();
