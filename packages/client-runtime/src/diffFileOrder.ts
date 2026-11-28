interface OrderableDiffFile {
  readonly additionLines: ReadonlyArray<string>;
  readonly deletionLines: ReadonlyArray<string>;
}

type DiffFileTier = "source" | "test" | "generated";

const GENERATED_FILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "go.sum",
  "gradle.lockfile",
  "composer.lock",
  "Gemfile.lock",
  "packages.lock.json",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "flake.lock",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
]);
const GENERATED_DIRECTORIES = new Set([
  "__snapshots__",
  "__generated__",
  "dist",
  "build",
  "vendor",
]);
const TEST_DIRECTORIES = new Set(["__tests__", "tests", "test"]);
// `.mts` also ends in `.ts`, so longer extensions come first.
const MODULE_EXTENSIONS = [".mts", ".cts", ".mjs", ".cjs", ".tsx", ".jsx", ".ts", ".js"];

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

function resolveRelative(fromPath: string, specifier: string): string | null {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join("/");
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

function importedPaths(
  path: string,
  lines: ReadonlyArray<string>,
  exactPaths: ReadonlySet<string>,
  byModulePath: ReadonlyMap<string, string>,
  byModuleName: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(IMPORT_SPECIFIER)) {
      // Bundler queries such as `?worker` or `?url` name the same file.
      const specifier = (match[1] ?? "").replace(/\?.*$/, "");
      const isRelative = specifier.startsWith(".");
      const resolvedPath = isRelative ? resolveRelative(path, specifier) : specifier;
      if (specifier === "" || resolvedPath === null) continue;
      const resolved = stripModuleExtension(resolvedPath);
      // `.` or `..` that lands on the repository root can only mean its index file.
      const target =
        resolvedPath === ""
          ? byModulePath.get("index")
          : ((exactPaths.has(resolvedPath) ? resolvedPath : undefined) ??
            byModulePath.get(resolved) ??
            byModulePath.get(`${resolved}/index`) ??
            (isRelative ? undefined : byModuleName.get(moduleName(resolved))));
      if (target !== undefined && target !== path) imported.add(target);
    }
  }
  return imported;
}

function pushMinHeap(heap: Array<number>, value: number): void {
  heap.push(value);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    const parentValue = heap[parent]!;
    if (parentValue <= value) break;
    heap[child] = parentValue;
    child = parent;
  }
  heap[child] = value;
}

function popMinHeap(heap: Array<number>): number {
  const root = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return root;
  let parent = 0;
  const half = heap.length >> 1;
  while (parent < half) {
    let child = (parent << 1) + 1;
    let childValue = heap[child]!;
    const right = child + 1;
    if (right < heap.length && heap[right]! < childValue) {
      child = right;
      childValue = heap[right]!;
    }
    if (last <= childValue) break;
    heap[parent] = childValue;
    parent = child;
  }
  heap[parent] = last;
  return root;
}

function orderByImports(
  paths: ReadonlyArray<string>,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): Array<string> {
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  const count = sorted.length;
  const indexByPath = new Map<string, number>();
  for (let index = 0; index < count; index++) {
    indexByPath.set(sorted[index]!, index);
  }

  const inDegree = new Int32Array(count);
  const emitted = new Uint8Array(count);
  const dependents: Array<Array<number>> = Array.from({ length: count }, () => []);
  for (let index = 0; index < count; index++) {
    const dependencies = imports.get(sorted[index]!);
    if (dependencies === undefined) continue;
    for (const dependency of dependencies) {
      const dependencyIndex = indexByPath.get(dependency);
      if (dependencyIndex === undefined) continue;
      inDegree[index] = inDegree[index]! + 1;
      dependents[dependencyIndex]!.push(index);
    }
  }

  const ready: Array<number> = [];
  for (let index = 0; index < count; index++) {
    if (inDegree[index] === 0) ready.push(index);
  }

  const ordered: Array<string> = [];
  let nextRemaining = 0;
  for (let step = 0; step < count; step++) {
    let nextIndex: number;
    if (ready.length > 0) {
      nextIndex = popMinHeap(ready);
    } else {
      while (emitted[nextRemaining] === 1) nextRemaining++;
      nextIndex = nextRemaining++;
    }
    emitted[nextIndex] = 1;
    ordered.push(sorted[nextIndex]!);

    for (const dependent of dependents[nextIndex]!) {
      if (emitted[dependent] === 1) continue;
      const remainingDependencies = inDegree[dependent]! - 1;
      inDegree[dependent] = remainingDependencies;
      if (remainingDependencies === 0) pushMinHeap(ready, dependent);
    }
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

function orderByImportsAndTier<F extends OrderableDiffFile>(
  files: ReadonlyArray<F>,
  pathOf: (file: F) => string,
): ReadonlyArray<F> {
  // A type change (file to symlink) is a delete and an add under one path; keep both.
  const byPath = new Map<string, F[]>();
  for (const file of files) {
    const path = pathOf(file);
    byPath.set(path, [...(byPath.get(path) ?? []), file]);
  }
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path));

  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const exactPaths = new Set(sourcePaths);
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
    const lines = byPath
      .get(path)!
      .flatMap((file) => [...file.additionLines, ...file.deletionLines]);
    imports.set(path, importedPaths(path, lines, exactPaths, byModulePath, byModuleName));
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

  return [...orderedSource, ...orderedTests, ...orderedGenerated].flatMap((path) =>
    byPath.get(path)!,
  );
}

/** Where each file, and each directory (with a trailing slash), first appears in `paths`. */
export function diffFileTreePositions(paths: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  paths.forEach((path, index) => {
    positions.set(path, index);
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      if (!positions.has(directory)) positions.set(directory, index);
    }
  });
  return positions;
}

function orderLikeTree<F>(files: ReadonlyArray<F>, pathOf: (file: F) => string): ReadonlyArray<F> {
  const paths = files.map(pathOf);
  const positions = diffFileTreePositions(paths);
  const keys = paths.map((path) => {
    const key: number[] = [];
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      key.push(positions.get(directory)!);
    }
    key.push(positions.get(path)!);
    return key;
  });
  return files
    .map((file, index) => ({ file, key: keys[index]! }))
    .sort((left, right) => {
      const length = Math.min(left.key.length, right.key.length);
      for (let index = 0; index < length; index++) {
        const difference = left.key[index]! - right.key[index]!;
        if (difference !== 0) return difference;
      }
      return left.key.length - right.key.length;
    })
    .map(({ file }) => file);
}

/**
 * Review order shared by every client: dependencies before dependents, tests after their source,
 * generated files last, then regrouped so each directory stays contiguous and a file tree built
 * from `diffFileTreePositions` lists files in the same order.
 */
export function orderDiffFilesForReview<F extends OrderableDiffFile>(
  files: ReadonlyArray<F>,
  pathOf: (file: F) => string,
): ReadonlyArray<F> {
  return orderLikeTree(orderByImportsAndTier(files, pathOf), pathOf);
}
