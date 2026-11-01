import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as ts from "typescript-api/unstable/ast";
import type { Node, SourceFile } from "typescript-api/unstable/ast";
import {
  docCommentLines,
  jsdocCopyId,
  LINK_TAG_RE,
  markDocLines,
  normalizeLinkTarget,
  parseLinkTag,
} from "./jsdoc-blocks.ts";
import { createSyntaxProject } from "./typescript-source.ts";

const websiteRoot = path.join(import.meta.dir, "../website");

interface SourceRoot {
  /** Directory scanned for documented source files. */
  srcRoot: string;
  /**
   * Synthetic provider name for flat single-provider packages (their files
   * sit directly at `srcRoot`); empty for the alchemy package, whose
   * top-level directories ARE the providers.
   */
  providerPrefix: string;
  /** Display prefix for the page's `Source:` line. */
  sourceDisplayPrefix: string;
}

const repoRoot = path.join(import.meta.dir, "..");

const config = {
  outRoot: path.join(websiteRoot, "src/content/docs/providers"),
  /**
   * Emit `<!--copy:jsdoc:...-->` markers after each prose block so the
   * website's dev-time copy editor can map rendered text back to the JSDoc
   * it came from. Dev only — production builds never set this.
   */
  copyMarkers:
    process.env.API_REFERENCE_COPY_MARKERS === "1" ||
    process.argv.includes("--copy-markers"),
  roots: [
    {
      srcRoot: path.join(import.meta.dir, "../packages/alchemy/src"),
      providerPrefix: "",
      sourceDisplayPrefix: "src",
    },
    {
      srcRoot: path.join(import.meta.dir, "../packages/better-auth/src"),
      providerPrefix: "BetterAuth",
      sourceDisplayPrefix: "packages/better-auth/src",
    },
  ] satisfies SourceRoot[],
};

interface FileEntry {
  /** Output-relative path (provider-prefixed for flat packages). */
  relativePath: string;
  absolutePath: string;
  /** Display path for the page's `Source:` blockquote. */
  sourceDisplay: string;
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
  /** Display path for the `Source:` blockquote. */
  sourceDisplay: string;
  summary: string;
  sections: ExampleSection[];
  /** True for `@layer` pages — renders the Layer metadata line. */
  isLayer: boolean;
  /** Service tags the Layer provides (`@provides`). */
  provides: string[];
  /** Optional peer dependencies (`@peer`). */
  peers: string[];
}

const normalizeSlashes = (value: string) => value.split(path.sep).join("/");

const isSourceFile = (baseName: string) =>
  (baseName.endsWith(".ts") || baseName.endsWith(".tsx")) &&
  !baseName.endsWith(".d.ts") &&
  baseName !== "index.ts";

async function discoverFiles(root: SourceRoot): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  // Flat single-provider packages: every file under srcRoot belongs to the
  // synthetic provider directory.
  if (root.providerPrefix) {
    const files = (await fs.readdir(root.srcRoot, {
      recursive: true,
    })) as string[];
    for (const file of files) {
      if (!isSourceFile(path.basename(file))) continue;
      entries.push({
        relativePath: path.join(root.providerPrefix, file),
        absolutePath: path.join(root.srcRoot, file),
        sourceDisplay: `${root.sourceDisplayPrefix}/${normalizeSlashes(file)}`,
      });
    }
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return entries;
  }

  const topLevelEntries = await fs.readdir(root.srcRoot, {
    withFileTypes: true,
  });
  const dirs = topLevelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const dir of dirs) {
    const dirPath = path.join(root.srcRoot, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      if (!isSourceFile(path.basename(file))) continue;

      const relativePath = path.join(dir, file);
      entries.push({
        relativePath,
        absolutePath: path.join(root.srcRoot, relativePath),
        sourceDisplay: `${root.sourceDisplayPrefix}/${normalizeSlashes(relativePath)}`,
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function getJsDocText(node: Node): string {
  return node.jsDoc?.map((doc) => doc.getText()).join("\n") ?? "";
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
  /** `@layer` — a Layer factory providing a Context service. */
  hasLayerTag: boolean;
  /** `@provides <Service.Tag>` — service tags the Layer satisfies. */
  provides: string[];
  /** `@peer <package>` — optional peer dependencies the Layer needs. */
  peers: string[];
  category: string;
  product: string;
}

/** Where a declaration's JSDoc lives, for copy markers. */
interface MarkerContext {
  /** Repo-relative path of the source file. */
  file: string;
  /** Full source text (JSDoc offsets index into it). */
  text: string;
}

function docLines(node: Node, raw: string, markers?: MarkerContext): string[] {
  const docs = node.jsDoc ?? [];
  // Markers need one comment per declaration to map blocks to source.
  const start = docs[0]?.getStart();
  // `getStart()` can land on leading `//` trivia; only map clean comments.
  if (
    markers &&
    docs.length === 1 &&
    start !== undefined &&
    markers.text.startsWith("/**", start)
  ) {
    return markDocLines(docCommentLines(markers.text, start), (block) =>
      jsdocCopyId(markers.file, start, block),
    );
  }
  return cleanDocComment(raw).split("\n");
}

function parseJSDoc(node: Node, markers?: MarkerContext): ParsedJSDoc {
  const raw = getJsDocText(node);
  if (!raw) {
    return {
      summary: "",
      sections: [],
      hasResourceTag: false,
      hasBindingTag: false,
      hasLayerTag: false,
      provides: [],
      peers: [],
      category: "",
      product: "",
    };
  }

  const lines = docLines(node, raw, markers);

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  const provides: string[] = [];
  const peers: string[] = [];
  let hasResourceTag = false;
  let hasBindingTag = false;
  let hasLayerTag = false;
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

    const proseHeading = insideFence
      ? null
      : line.trim().match(/^###\s+(.+?)\s+<!-- api-prose -->$/);
    if (proseHeading) {
      if (!sawTag) summaryLines.push(`### ${proseHeading[1]!.trim()}`);
      continue;
    }

    const section = insideFence ? null : line.trim().match(/^###\s+(.+)$/);
    if (section) {
      sawTag = true;
      flushExample();
      flushSectionDesc();
      currentSection = {
        title: section[1]!.trim(),
        description: "",
        examples: [],
      };
      sections.push(currentSection);
      collectingSectionDesc = true;
      continue;
    }

    const example = insideFence
      ? null
      : line.trim().match(/^\*\*Example:\*\*\s*(.*)$/);
    if (example) {
      sawTag = true;
      flushSectionDesc();
      flushExample();
      currentExample = {
        title: example[1]!.trim() || "Example",
        body: "",
      };
      continue;
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
        case "layer":
          hasLayerTag = true;
          break;
        case "provides":
          if (value) provides.push(value);
          break;
        case "peer":
          if (value) peers.push(value);
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
    hasLayerTag,
    provides,
    peers,
    category,
    product,
  };
}

function declName(node: Node): string {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations[0]?.name.getText() ?? "";
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name?.getText() ?? "";
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
export function exportedNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else
      for (const element of name.elements) {
        if (ts.isBindingElement(element) && element.name)
          addBinding(element.name);
      }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const spec of statement.exportClause.elements)
          names.add(spec.name.text);
      } else if (
        statement.exportClause &&
        ts.isNamespaceExport(statement.exportClause)
      ) {
        names.add(statement.exportClause.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) names.add("default");
    } else if (
      (ts.isVariableStatement(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      statement.modifierFlags & ts.ModifierFlags.Export
    ) {
      if (statement.modifierFlags & ts.ModifierFlags.Default)
        names.add("default");
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          addBinding(declaration.name);
      } else if (
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        if (statement.name) names.add(statement.name.text);
      }
    }
  }
  return [...names];
}

function localNameForExport(
  sourceFile: SourceFile,
  publicName: string,
): string | undefined {
  for (const ed of sourceFile.statements.filter(ts.isExportDeclaration)) {
    if (ed.moduleSpecifier) continue;
    for (const spec of ed.exportClause && ts.isNamedExports(ed.exportClause)
      ? ed.exportClause.elements
      : []) {
      if (spec.name.text === publicName) {
        return (spec.propertyName ?? spec.name).text;
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
export function findTaggedPrimary(
  sourceFile: SourceFile,
  markers?: MarkerContext,
): Primary | undefined {
  const candidates: Node[] = [
    ...sourceFile.statements
      .filter(ts.isVariableStatement)
      .filter((s) => Boolean(s.modifierFlags & ts.ModifierFlags.Export)),
    ...sourceFile.statements
      .filter(ts.isClassDeclaration)
      .filter((c) => Boolean(c.modifierFlags & ts.ModifierFlags.Export)),
    ...sourceFile.statements
      .filter(ts.isInterfaceDeclaration)
      .filter((i) => Boolean(i.modifierFlags & ts.ModifierFlags.Export)),
  ];

  for (const node of candidates) {
    const doc = parseJSDoc(node, markers);
    if (!doc.hasResourceTag && !doc.hasBindingTag && !doc.hasLayerTag) {
      continue;
    }
    const name = declName(node);
    if (!name) continue;
    const category = doc.category;
    const product = doc.product;
    if (hasContent(doc)) return { name, doc, category, product };

    // Tagged declaration has no prose — look for the related declaration that
    // carries the docs (same name, or re-exported under this name).
    const localName = localNameForExport(sourceFile, name);
    const related: Node[] = [
      ...sourceFile.statements.filter(ts.isVariableStatement),
      ...sourceFile.statements.filter(ts.isClassDeclaration),
      ...sourceFile.statements.filter(ts.isInterfaceDeclaration),
      ...sourceFile.statements.filter(ts.isTypeAliasDeclaration),
    ].filter((d) => {
      if (d === node) return false;
      const dn = declName(d);
      return dn === name || (localName !== undefined && dn === localName);
    });

    let best: ParsedJSDoc | undefined;
    for (const d of related) {
      const pd = parseJSDoc(d, markers);
      if (pd.sections.length > 0) {
        best = pd;
        break;
      }
      if (!best && pd.summary) best = pd;
    }
    // Borrowed prose keeps the TAGGED declaration's kind + metadata.
    const merged: ParsedJSDoc = {
      ...(best ?? doc),
      hasResourceTag: doc.hasResourceTag,
      hasBindingTag: doc.hasBindingTag,
      hasLayerTag: doc.hasLayerTag,
      provides: doc.provides,
      peers: doc.peers,
    };
    return { name, doc: merged, category, product };
  }
  return undefined;
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

    const lookup = (name: string, provider?: string): PageEntry | undefined => {
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

function yamlString(value: string): string {
  if (/[\n:"{}[\],&*?|>!%@`#]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
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

function renderReferenceFrontmatter(title: string): string {
  return [
    "---",
    `title: ${yamlString(`${title} reference`)}`,
    `description: ${yamlString(`Resources and capabilities for ${title}.`)}`,
    // Keep the existing search-engine indexing policy during this experiment.
    "head:",
    "  - tag: meta",
    "    attrs:",
    "      name: robots",
    '      content: "noindex, follow"',
    "prev: false",
    "next: false",
    "tableOfContents:",
    "  minHeadingLevel: 2",
    "  maxHeadingLevel: 2",
    "---",
  ].join("\n");
}

function renderResource(doc: PageDoc, resolve: LinkResolver): string {
  const headerLines = [`> **Source:** \`${doc.sourceDisplay}\``];
  if (doc.isLayer) {
    const meta = ["**Kind:** Layer"];
    if (doc.provides.length > 0) {
      meta.push(
        `**Provides:** ${doc.provides.map((tag) => `\`${tag}\``).join(", ")}`,
      );
    }
    if (doc.peers.length > 0) {
      meta.push(
        `**Peer dependencies:** ${doc.peers
          .map((peer) => `\`${peer}\``)
          .join(", ")}`,
      );
    }
    headerLines.push(`> ${meta.join(" · ")}`);
  }
  const sourceBlock = headerLines.join("\n");
  const body = linkifyMarkdown(renderPageBody(doc).trim(), resolve);

  if (body) {
    return `${sourceBlock}\n\n${body}\n`;
  }
  return `${sourceBlock}\n`;
}

/** Change this grouping to experiment with larger or smaller reference pages. */
function referenceLocation(outputRelative: string, product: string) {
  const parts = normalizeSlashes(outputRelative)
    .replace(/\.md$/, "")
    .split("/");
  // Flat providers declare service-sized pages with @product instead of folders.
  const group =
    parts.length > 2
      ? parts.slice(0, 2)
      : product
        ? [
            parts[0],
            "reference",
            product
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, ""),
          ]
        : [parts[0], "reference"];
  const title = parts.slice(parts.length > 2 ? 2 : 1).join("-");
  return {
    outputRelative: `${group.join("/")}.md`,
    title:
      parts.length > 2
        ? group.join(".")
        : product
          ? `${parts[0]}.${product}`
          : parts[0],
    resourceTitle: title,
    link: `/providers/${group.join("/").toLowerCase()}#${title.toLowerCase()}`,
  };
}

/** Keep example headings below their resource, with resource-scoped slugs. */
function nestResourceHeadings(markdown: string, resource: string): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = undefined;
        return line;
      }
      if (fence) return line;
      return line.replace(
        /^(#{1,6})\s+(.+)$/,
        (_, hashes: string, title: string) =>
          `${"#".repeat(Math.min(6, Math.max(3, hashes.length + 1)))} ${resource}: ${title}`,
      );
    })
    .join("\n");
}

/** Providers shown first in the sidebar; the rest follow alphabetically. */
const PROVIDER_ORDER = ["AWS", "Cloudflare"];

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

/** The sidebar lists documents; resource anchors live in the page's TOC. */
function buildServiceItems(pages: PageEntry[]): SidebarItem[] {
  return pages
    .map((page) => ({
      label: page.product || page.service || page.provider,
      link: page.link,
    }))
    .sort(byLabel);
}

function buildProvidersSidebar(entries: PageEntry[]): SidebarItem[] {
  const byProvider = new Map<string, PageEntry[]>();
  for (const e of entries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push(e);
  }

  const providers: SidebarGroup[] = [];
  for (const provider of orderedKeys([...byProvider.keys()], PROVIDER_ORDER)) {
    const byPage = new Map<string, PageEntry[]>();
    for (const entry of byProvider.get(provider)!) {
      const link = entry.link.split("#")[0];
      if (!byPage.has(link)) byPage.set(link, []);
      byPage.get(link)!.push(entry);
    }
    const pages = [...byPage].map(([link, resources]) => ({
      ...resources[0],
      link,
      product: resources.every(
        (resource) => resource.product === resources[0].product,
      )
        ? resources[0].product
        : "",
    }));

    const items = buildServiceItems(pages);

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

/**
 * Writes `content` only when it differs from what's on disk, so a dev server
 * watching the output reloads just the pages that changed.
 */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current === content) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return true;
}

/** Deletes files under `dir` not in `keep`, then any directories left empty. */
async function pruneOutput(dir: string, keep: Set<string>): Promise<void> {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await pruneOutput(full, keep);
      const left = await fs.readdir(full).catch(() => []);
      if (left.length === 0) await fs.rmdir(full).catch(() => {});
    } else if (!keep.has(full)) {
      await fs.rm(full, { force: true });
    }
  }
}

async function main() {
  await fs.mkdir(config.outRoot, { recursive: true });
  const outputs = new Set<string>();

  const seen = new Map<string, string>();
  const pageEntries: PageEntry[] = [];
  const pending: { outputRelative: string; product: string; doc: PageDoc }[] =
    [];
  let written = 0;
  const redirects: Record<string, string> = {};
  const anchors = new Set<string>();
  let skipped = 0;

  for (const root of config.roots) {
    const entries = await discoverFiles(root);
    console.log(
      `Discovered ${entries.length} source files in ${normalizeSlashes(
        path.relative(path.join(import.meta.dir, ".."), root.srcRoot),
      )}.`,
    );

    await using syntax = await createSyntaxProject(
      entries.map((entry) => entry.absolutePath),
    );

    for (const entry of entries) {
      const sourceFile = await syntax.project.program.getSourceFile(
        entry.absolutePath,
      );
      if (!sourceFile) {
        throw new Error(`Missing source file ${entry.absolutePath}`);
      }

      const primary = findTaggedPrimary(
        sourceFile,
        config.copyMarkers
          ? {
              file: normalizeSlashes(
                path.relative(repoRoot, entry.absolutePath),
              ),
              text: sourceFile.text,
            }
          : undefined,
      );
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
        sourceDisplay: entry.sourceDisplay,
        summary: primary.doc.summary,
        sections: primary.doc.sections,
        isLayer: primary.doc.hasLayerTag,
        provides: primary.doc.provides,
        peers: primary.doc.peers,
      };
      pending.push({ outputRelative, product: primary.product, doc });

      const exportNames = exportedNames(sourceFile);

      const segments = normalizeSlashes(outputRelative).split("/");
      const location = referenceLocation(outputRelative, primary.product);
      const oldLink = `/providers/${normalizeSlashes(outputRelative).replace(/\.md$/, "").toLowerCase()}`;
      if (anchors.has(location.link)) {
        throw new Error(`Duplicate reference anchor: ${location.link}`);
      }
      anchors.add(location.link);
      redirects[oldLink] = location.link;
      pageEntries.push({
        provider: segments[0] ?? "",
        service: segments.length > 2 ? segments[1] : "",
        resource: primary.name,
        category: primary.category,
        product: primary.product,
        link: location.link,
        dir: normalizeSlashes(relDir),
        exports: exportNames,
      });
    }
  }

  // Second pass: render with `{@link}` resolution — the full page set must be
  // known before symbol targets can resolve to their pages.
  const resolverFor = makeLinkResolverFactory(pageEntries);
  const groups = new Map<string, { title: string; sections: string[] }>();
  for (const page of pending) {
    const location = referenceLocation(page.outputRelative, page.product);
    const resolve = resolverFor(
      normalizeSlashes(path.dirname(page.outputRelative)),
    );
    const group = groups.get(location.outputRelative) ?? {
      title: location.title,
      sections: [],
    };
    group.sections.push(
      `## ${location.resourceTitle}\n\n${nestResourceHeadings(renderResource(page.doc, resolve), location.resourceTitle)}`,
    );
    groups.set(location.outputRelative, group);
  }
  for (const [relative, group] of groups) {
    const outputPath = path.join(config.outRoot, relative);
    outputs.add(outputPath);
    if (
      await writeIfChanged(
        outputPath,
        `${renderReferenceFrontmatter(group.title)}\n\n${group.sections.join("\n\n")}\n`,
      )
    ) {
      written++;
    }
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
  const indexPath = path.join(config.outRoot, "index.mdx");
  outputs.add(indexPath);
  await writeIfChanged(indexPath, referenceIndex);
  await pruneOutput(config.outRoot, outputs);

  const sidebarPath = path.join(
    websiteRoot,
    "src/generated/providers-sidebar.json",
  );
  await writeIfChanged(
    path.join(websiteRoot, "src/generated/reference-redirects.json"),
    `${JSON.stringify(redirects, null, 2)}\n`,
  );
  // astro.config imports the sidebar, so rewriting it restarts a dev server.
  await writeIfChanged(sidebarPath, `${JSON.stringify(sidebar, null, 2)}\n`);

  console.log(
    `Done. Wrote ${written} changed reference pages containing ${pending.length} resources (skipped ${skipped} untagged${
      config.copyMarkers ? ", with copy markers" : ""
    }) to ${normalizeSlashes(
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

if (import.meta.main) await main();
