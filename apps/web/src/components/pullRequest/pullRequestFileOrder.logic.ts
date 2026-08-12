import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath } from "~/lib/diffRendering";

/**
 * Which of the three reading passes a file belongs to.
 *
 * A reviewer reads the change itself first, then what proves it, and a lockfile or a build output
 * only ever confirms what the source already said. Ordering by path alone buries the one file the
 * change is really about under whichever directory happens to sort first.
 */
export type DiffFileTier = "source" | "test" | "generated";

const GENERATED_FILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const GENERATED_DIRECTORIES = new Set([
  "__snapshots__",
  "__generated__",
  "dist",
  "build",
  "vendor",
]);
const TEST_DIRECTORIES = new Set(["__tests__", "tests", "test"]);
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function diffFileTier(path: string): DiffFileTier {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (
    GENERATED_FILE_NAMES.has(name) ||
    name.endsWith(".snap") ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    /\.generated\./.test(name) ||
    segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))
  ) {
    return "generated";
  }
  if (
    /\.(?:test|spec)\./.test(name) ||
    segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment))
  ) {
    return "test";
  }
  return "source";
}

function stripExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

function baseName(path: string): string {
  return stripExtension(path.split("/").at(-1) ?? "");
}

/** Resolves `../x` against the importer's directory; no package resolution, only what git shows. */
function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

// `import x from "y"`, `import "y"`, `export … from "y"` and `require("y")` all reduce to a quoted
// specifier preceded by one of three words.
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

/** Which changed files a file's patch lines import, by path. */
function importedPaths(
  path: string,
  lines: ReadonlyArray<string>,
  byModulePath: ReadonlyMap<string, string>,
  byBaseName: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      const specifier = match[1] ?? "";
      const withExtension = specifier.startsWith(".")
        ? resolveRelative(path, specifier)
        : specifier;
      // A specifier may name the extension the module map dropped, and it need not be the one on
      // disk: TypeScript's own imports point at the `.js` beside a `.ts`.
      const extension = MODULE_EXTENSIONS.find((candidate) => withExtension.endsWith(candidate));
      const resolved =
        extension === undefined ? withExtension : withExtension.slice(0, -extension.length);
      const target =
        byModulePath.get(resolved) ??
        byModulePath.get(`${resolved}/index`) ??
        byBaseName.get(baseName(resolved));
      if (target !== undefined && target !== path) imported.add(target);
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return imported;
}

/**
 * Source files with what they import ahead of what imports them.
 *
 * Kahn's, but every step takes the lowest remaining path rather than any ready node, so the same
 * change always reads the same way and files of one directory stay together. A cycle leaves nothing
 * ready: the lowest path still standing is taken anyway, which is the alphabetical order the tier
 * would have had without a graph.
 */
function orderByImports(
  paths: ReadonlyArray<string>,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): Array<string> {
  const remaining = new Set(paths);
  const ordered: Array<string> = [];
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  while (remaining.size > 0) {
    const candidates = sorted.filter((path) => remaining.has(path));
    const next =
      candidates.find((path) =>
        [...(imports.get(path) ?? [])].every((dependency) => !remaining.has(dependency)),
      ) ?? candidates[0]!;
    remaining.delete(next);
    ordered.push(next);
  }
  return ordered;
}

/** The implementation a test names: `foo.test.ts` and `__tests__/foo.ts` both point at `foo`. */
function testedBaseName(path: string): string {
  return (path.split("/").at(-1) ?? "").replace(/\.(?:test|spec)\..*$/, "").replace(/\.[^.]+$/, "");
}

/**
 * Diff files in reading order: source in dependency order, then the tests that cover it, then
 * whatever a tool wrote.
 */
export function orderDiffFiles(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<FileDiffMetadata> {
  const byPath = new Map<string, FileDiffMetadata>();
  for (const file of files) byPath.set(resolveFileDiffPath(file), file);
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path));

  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const byModulePath = new Map<string, string>();
  const ambiguousBaseNames = new Set<string>();
  const byBaseName = new Map<string, string>();
  for (const path of sourcePaths) {
    byModulePath.set(stripExtension(path), path);
    const base = baseName(path);
    if (byBaseName.has(base)) ambiguousBaseNames.add(base);
    byBaseName.set(base, path);
  }
  for (const base of ambiguousBaseNames) byBaseName.delete(base);

  const imports = new Map<string, ReadonlySet<string>>();
  for (const path of sourcePaths) {
    const file = byPath.get(path)!;
    imports.set(
      path,
      importedPaths(path, [...file.additionLines, ...file.deletionLines], byModulePath, byBaseName),
    );
  }
  const orderedSource = orderByImports(sourcePaths, imports);

  const sourcePositions = new Map<string, number>();
  orderedSource.forEach((path, index) => {
    const base = baseName(path);
    if (!sourcePositions.has(base)) sourcePositions.set(base, index);
  });
  const orderedTests = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "test")
    .sort((left, right) => {
      const leftPosition = sourcePositions.get(testedBaseName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = sourcePositions.get(testedBaseName(right)) ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.localeCompare(right);
    });

  const orderedGenerated = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "generated")
    .sort((left, right) => left.localeCompare(right));

  return [...orderedSource, ...orderedTests, ...orderedGenerated].map((path) => byPath.get(path)!);
}
