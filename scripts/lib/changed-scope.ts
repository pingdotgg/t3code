/**
 * Map a set of changed files onto the smallest set of checks that can still
 * prove the change is good.
 *
 * The monorepo's default verification story is "run everything": `vp check`
 * lints the whole tree, `vp run -r test` runs all 411 test files, and
 * `swift test` rebuilds the macOS app. That is the right answer before a PR
 * and the wrong answer after every edit, so this module answers the narrower
 * question — given these files, which packages can possibly have broken?
 *
 * Pure and dependency-free so it can be unit tested without a workspace.
 */

/** A pnpm workspace package, located by its repo-relative directory. */
export interface WorkspacePackage {
  /** Package name from its `package.json`, e.g. `@t3tools/shared`. */
  readonly name: string;
  /** Repo-relative directory with no trailing slash, e.g. `packages/shared`. */
  readonly directory: string;
}

export interface ChangedScope {
  /**
   * Workspace packages that own at least one changed file. Empty when the
   * change touches nothing that a JavaScript package builds.
   */
  readonly packages: readonly string[];
  /** The macOS SwiftPM app changed and needs `swift build` / `swift test`. */
  readonly touchesMac: boolean;
  /** Native mobile sources changed and need `lint:mobile`. */
  readonly touchesMobileNative: boolean;
  /**
   * A workspace-wide input changed (lockfile, root config, patches, shared
   * tsconfig). Nothing narrower is trustworthy, so callers should fall back to
   * the full suite.
   */
  readonly touchesWorkspaceRoot: boolean;
  /**
   * Changed TypeScript/JavaScript sources, for `vitest related`, which walks
   * the module graph to find the tests that import them.
   */
  readonly relatedSources: readonly string[];
  /** Changed files worth handing to `vp check` (format + lint). */
  readonly checkPaths: readonly string[];
}

/**
 * Files that invalidate every package's build. A change here means the narrow
 * answer would be a lie, so `touchesWorkspaceRoot` forces the full suite.
 */
const workspaceRootInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "vite.config.ts",
]);

const workspaceRootPrefixes = ["patches/"];

/** Paths that never affect any check, so they should not trigger one. */
const ignoredPrefixes = [
  ".claude/",
  ".cursor/",
  ".plans/",
  ".repos/",
  ".vscode/",
  "docs/",
  "node_modules/",
  "plans/",
];

const relatedSourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const nativeMobileExtensions = new Set([".swift", ".kt", ".kts"]);

/** Extensions `vp fmt`/`vp lint` actually handle; see `fmt`/`lint` in vite.config.ts. */
const checkableExtensions = [
  ...relatedSourceExtensions,
  ".css",
  ".html",
  ".json",
  ".md",
  ".yaml",
  ".yml",
];

function extensionOf(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = filePath.lastIndexOf("/");
  return lastDot > lastSlash ? filePath.slice(lastDot) : "";
}

function isIgnored(filePath: string): boolean {
  return ignoredPrefixes.some((prefix) => filePath.startsWith(prefix));
}

function isWorkspaceRootInput(filePath: string): boolean {
  return (
    workspaceRootInputs.has(filePath) ||
    workspaceRootPrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}

/**
 * Owning package for a file, or `null` when it belongs to no workspace package.
 *
 * Longest directory wins so that a nested package (`apps/mobile/modules/x`)
 * beats its ancestor rather than both claiming the file.
 */
function ownerOf(filePath: string, packages: readonly WorkspacePackage[]): WorkspacePackage | null {
  let best: WorkspacePackage | null = null;
  for (const candidate of packages) {
    if (!filePath.startsWith(`${candidate.directory}/`)) {
      continue;
    }
    if (best === null || candidate.directory.length > best.directory.length) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Resolve the checks a change actually needs.
 *
 * `changedFiles` are repo-relative POSIX paths, as produced by
 * `git diff --name-only`. Deleted files are fine to pass through: they still
 * identify the package whose tests should re-run.
 */
export function resolveChangedScope(
  changedFiles: readonly string[],
  packages: readonly WorkspacePackage[],
): ChangedScope {
  const packageNames = new Set<string>();
  const relatedSources: string[] = [];
  const checkPaths: string[] = [];
  let touchesMac = false;
  let touchesMobileNative = false;
  let touchesWorkspaceRoot = false;

  for (const filePath of changedFiles) {
    if (filePath === "" || isIgnored(filePath)) {
      continue;
    }
    if (isWorkspaceRootInput(filePath)) {
      touchesWorkspaceRoot = true;
    }

    const extension = extensionOf(filePath);
    if (filePath.startsWith("apps/mac/")) {
      touchesMac = true;
    }
    if (filePath.startsWith("apps/mobile/") && nativeMobileExtensions.has(extension)) {
      touchesMobileNative = true;
    }

    const owner = ownerOf(filePath, packages);
    if (owner !== null && relatedSourceExtensions.includes(extension)) {
      packageNames.add(owner.name);
    }
    if (relatedSourceExtensions.includes(extension)) {
      relatedSources.push(filePath);
    }
    if (checkableExtensions.includes(extension)) {
      checkPaths.push(filePath);
    }
  }

  return {
    packages: [...packageNames].sort(),
    touchesMac,
    touchesMobileNative,
    touchesWorkspaceRoot,
    relatedSources,
    checkPaths,
  };
}

/**
 * `--filter` expressions for `vp run`, one per changed package.
 *
 * The `...` prefix selects the package *and its dependents*, which is the
 * whole point: editing `packages/contracts` must re-typecheck `apps/server`,
 * not just contracts.
 */
export function dependentFilters(packages: readonly string[]): readonly string[] {
  return packages.flatMap((name) => ["--filter", `...${name}`]);
}
