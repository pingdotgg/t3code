import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath } from "~/lib/diffRendering";

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

function diffFileTier(path: string): DiffFileTier {
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

// Import specifiers omit module extensions but keep dotted names such as `b.logic`, so module-map
// keys strip only the extensions an import could omit.
function stripModuleExtension(path: string): string {
  const extension = MODULE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  return extension === undefined ? path : path.slice(0, -extension.length);
}

function moduleName(path: string): string {
  return stripModuleExtension(path.split("/").at(-1) ?? "");
}

function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

function importedPaths(
  path: string,
  lines: ReadonlyArray<string>,
  byModulePath: ReadonlyMap<string, string>,
  byModuleName: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      // Bundler queries such as `?worker` or `?url` name the same file.
      const specifier = (match[1] ?? "").replace(/[?#].*$/, "");
      const resolved = stripModuleExtension(
        specifier.startsWith(".") ? resolveRelative(path, specifier) : specifier,
      );
      const target =
        byModulePath.get(resolved) ??
        byModulePath.get(`${resolved}/index`) ??
        byModuleName.get(moduleName(resolved));
      if (target !== undefined && target !== path) imported.add(target);
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return imported;
}

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

// `a.logic.test.ts` covers `a.logic.ts` while `a.browser.test.ts` covers `a.ts`, so the longest
// dotted prefix that names a source file wins.
function testedSourcePosition(path: string, sourcePositions: ReadonlyMap<string, number>): number {
  let name = (path.split("/").at(-1) ?? "").replace(/\.(?:test|spec)\..*$/, "");
  while (true) {
    const position = sourcePositions.get(name);
    if (position !== undefined) return position;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return Number.MAX_SAFE_INTEGER;
    name = name.slice(0, dot);
  }
}

export function orderDiffFiles(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<FileDiffMetadata> {
  const byPath = new Map<string, FileDiffMetadata>();
  for (const file of files) byPath.set(resolveFileDiffPath(file), file);
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path));

  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const byModulePath = new Map<string, string>();
  const ambiguousModuleNames = new Set<string>();
  const byModuleName = new Map<string, string>();
  for (const path of sourcePaths) {
    byModulePath.set(stripModuleExtension(path), path);
    const name = moduleName(path);
    if (byModuleName.has(name)) ambiguousModuleNames.add(name);
    byModuleName.set(name, path);
  }
  for (const name of ambiguousModuleNames) byModuleName.delete(name);

  const imports = new Map<string, ReadonlySet<string>>();
  for (const path of sourcePaths) {
    const file = byPath.get(path)!;
    imports.set(
      path,
      importedPaths(
        path,
        [...file.additionLines, ...file.deletionLines],
        byModulePath,
        byModuleName,
      ),
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
      return (
        testedSourcePosition(left, sourcePositions) -
          testedSourcePosition(right, sourcePositions) || left.localeCompare(right)
      );
    });

  const orderedGenerated = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "generated")
    .sort((left, right) => left.localeCompare(right));

  return [...orderedSource, ...orderedTests, ...orderedGenerated].map((path) => byPath.get(path)!);
}
