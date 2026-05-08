import path from "node:path";
import { Effect, FileSystem, Layer, Option } from "effect";
import * as PlatformError from "effect/PlatformError";

import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver.ts";

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
] as const;

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;
const IGNORED_WORKSPACE_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

type ExistingPathType = "File" | "Directory";

interface FaviconLookupServices {
  fileSystem: FileSystem.FileSystem;
  projectRoot: string;
  filterAllowedPaths: (candidatePaths: readonly string[]) => Effect.Effect<string[], never>;
}

function isPathInIgnoredWorkspaceDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) {
    return false;
  }

  return IGNORED_WORKSPACE_DIRECTORY_NAMES.has(firstSegment);
}

function extractIconHref(source: string): Option.Option<string> {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) {
    return Option.some(htmlMatch[1]);
  }

  const objectMatch = source.match(LINK_ICON_OBJ_RE);
  if (objectMatch?.[1]) {
    return Option.some(objectMatch[1]);
  }

  return Option.none();
}

function platformErrorToNone<A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, never, R> {
  return effect.pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", () => Effect.succeed(Option.none<A>())),
  );
}

function toProjectRelativePath(projectRoot: string, candidatePath: string): Option.Option<string> {
  const relativePath = path.relative(projectRoot, candidatePath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return Option.none();
  }

  return Option.some(relativePath.split(path.sep).join("/"));
}

function resolveExistingPath(
  lookup: Pick<FaviconLookupServices, "fileSystem" | "projectRoot">,
  candidatePath: string,
  expectedType: ExistingPathType,
) {
  return Effect.gen(function* () {
    const resolvedPathOption = yield* platformErrorToNone(
      lookup.fileSystem.realPath(candidatePath),
    );
    if (Option.isNone(resolvedPathOption)) {
      return Option.none();
    }

    const resolvedPath = resolvedPathOption.value;
    const relativePath = path.relative(lookup.projectRoot, resolvedPath);
    if (relativePath !== "" && (relativePath.startsWith("..") || path.isAbsolute(relativePath))) {
      return Option.none();
    }

    const infoOption = yield* platformErrorToNone(lookup.fileSystem.stat(resolvedPath));
    if (Option.isNone(infoOption) || infoOption.value.type !== expectedType) {
      return Option.none();
    }

    return Option.some(resolvedPath);
  });
}

function readFileIfExists<A>(
  lookup: Pick<FaviconLookupServices, "fileSystem" | "projectRoot">,
  candidatePath: string,
  read: (resolvedPath: string) => Effect.Effect<A, PlatformError.PlatformError>,
) {
  return Effect.gen(function* () {
    const resolvedPathOption = yield* resolveExistingPath(lookup, candidatePath, "File");
    if (Option.isNone(resolvedPathOption)) {
      return Option.none();
    }

    const contentOption = yield* platformErrorToNone(read(resolvedPathOption.value));
    if (Option.isNone(contentOption)) {
      return Option.none();
    }

    return Option.some({
      path: resolvedPathOption.value,
      content: contentOption.value,
    });
  });
}

function makeAllowedPathFilter(
  projectRoot: string,
  shouldFilterWithVcsIgnore: boolean,
  filterVcsIgnoredPaths: (relativePaths: string[]) => Effect.Effect<string[], never>,
) {
  const gitIgnorePathCache = new Map<string, boolean>();

  return (candidatePaths: readonly string[]) =>
    Effect.gen(function* () {
      if (!shouldFilterWithVcsIgnore || candidatePaths.length === 0) {
        return [...candidatePaths];
      }

      const uncachedRelativePaths = Array.from(
        new Set(
          candidatePaths.flatMap((candidatePath) =>
            Option.match(toProjectRelativePath(projectRoot, candidatePath), {
              onNone: () => [],
              onSome: (relativePath) =>
                gitIgnorePathCache.has(relativePath) ? [] : [relativePath],
            }),
          ),
        ),
      );

      if (uncachedRelativePaths.length > 0) {
        const allowedRelativePaths = yield* filterVcsIgnoredPaths(uncachedRelativePaths);
        const allowedRelativePathSet = new Set(allowedRelativePaths);

        for (const relativePath of uncachedRelativePaths) {
          gitIgnorePathCache.set(relativePath, allowedRelativePathSet.has(relativePath));
        }
      }

      return candidatePaths.filter((candidatePath) =>
        Option.match(toProjectRelativePath(projectRoot, candidatePath), {
          onNone: () => true,
          onSome: (relativePath) => gitIgnorePathCache.get(relativePath) !== false,
        }),
      );
    });
}

function findFirstReadableFaviconPath(
  lookup: FaviconLookupServices,
  candidatePaths: readonly string[],
) {
  return Effect.gen(function* () {
    const allowedCandidatePaths = yield* lookup.filterAllowedPaths(candidatePaths);

    for (const candidatePath of allowedCandidatePaths) {
      const fileOption = yield* readFileIfExists(lookup, candidatePath, (resolvedPath) =>
        lookup.fileSystem.readFile(resolvedPath),
      );
      if (Option.isSome(fileOption)) {
        return Option.some(fileOption.value.path);
      }
    }

    return Option.none();
  });
}

function iconHrefCandidatePaths(searchRoot: string, href: string): string[] {
  const cleanHref = href.replace(/^\//, "");
  return [path.join(searchRoot, "public", cleanHref), path.join(searchRoot, cleanHref)];
}

function findFaviconFromSourcePath(
  lookup: FaviconLookupServices,
  searchRoot: string,
  sourcePath: string,
) {
  return Effect.gen(function* () {
    const sourceFileOption = yield* readFileIfExists(lookup, sourcePath, (resolvedPath) =>
      lookup.fileSystem.readFileString(resolvedPath),
    );
    if (Option.isNone(sourceFileOption)) {
      return Option.none();
    }

    const hrefOption = extractIconHref(sourceFileOption.value.content);
    if (Option.isNone(hrefOption)) {
      return Option.none();
    }

    return yield* findFirstReadableFaviconPath(
      lookup,
      iconHrefCandidatePaths(searchRoot, hrefOption.value),
    );
  });
}

function findFaviconFromSourceFiles(lookup: FaviconLookupServices, searchRoot: string) {
  return Effect.gen(function* () {
    const sourcePaths = yield* lookup.filterAllowedPaths(
      ICON_SOURCE_FILES.map((sourceFile) => path.join(searchRoot, sourceFile)),
    );

    for (const sourcePath of sourcePaths) {
      const faviconPathOption = yield* findFaviconFromSourcePath(lookup, searchRoot, sourcePath);
      if (Option.isSome(faviconPathOption)) {
        return faviconPathOption;
      }
    }

    return Option.none();
  });
}

function findFaviconInSearchRoot(lookup: FaviconLookupServices, searchRoot: string) {
  return Effect.gen(function* () {
    const faviconPathOption = yield* findFirstReadableFaviconPath(
      lookup,
      FAVICON_CANDIDATES.map((candidate) => path.join(searchRoot, candidate)),
    );
    if (Option.isSome(faviconPathOption)) {
      return faviconPathOption;
    }

    return yield* findFaviconFromSourceFiles(lookup, searchRoot);
  });
}

function listChildDirectories(lookup: FaviconLookupServices, rootPath: string) {
  return Effect.gen(function* () {
    const entriesOption = yield* platformErrorToNone(lookup.fileSystem.readDirectory(rootPath));
    if (Option.isNone(entriesOption)) {
      return [];
    }

    const directories: string[] = [];
    for (const entry of entriesOption.value.toSorted((left, right) => left.localeCompare(right))) {
      if (entry.length === 0 || entry.includes("/") || entry.includes("\\")) {
        continue;
      }
      if (isPathInIgnoredWorkspaceDirectory(entry)) {
        continue;
      }

      const directoryPathOption = yield* resolveExistingPath(
        lookup,
        path.join(rootPath, entry),
        "Directory",
      );
      if (Option.isSome(directoryPathOption)) {
        directories.push(directoryPathOption.value);
      }
    }

    return directories;
  });
}

function listCandidateSearchRoots(lookup: FaviconLookupServices) {
  return Effect.gen(function* () {
    const [appRoots, packageRoots, directChildRoots] = yield* Effect.all([
      listChildDirectories(lookup, path.join(lookup.projectRoot, "apps")),
      listChildDirectories(lookup, path.join(lookup.projectRoot, "packages")),
      listChildDirectories(lookup, lookup.projectRoot),
    ]);

    return [
      ...appRoots,
      ...packageRoots,
      ...directChildRoots.filter((directChildRoot) => {
        const baseName = path.basename(directChildRoot).toLowerCase();
        return baseName !== "apps" && baseName !== "packages";
      }),
    ];
  });
}

function findNestedFavicon(lookup: FaviconLookupServices) {
  return Effect.gen(function* () {
    const searchRoots = yield* listCandidateSearchRoots(lookup).pipe(
      Effect.flatMap((roots) => lookup.filterAllowedPaths(roots)),
    );

    for (const searchRoot of searchRoots) {
      const faviconPathOption = yield* findFaviconInSearchRoot(lookup, searchRoot);
      if (Option.isSome(faviconPathOption)) {
        return faviconPathOption;
      }
    }

    return Option.none();
  });
}

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsRegistry = yield* VcsDriverRegistry;

  const isInsideVcsWorkTree = (cwd: string): Effect.Effect<boolean, never> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.map((handle) => handle !== null),
      Effect.catch(() => Effect.succeed(false)),
    );

  const filterVcsIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.flatMap((handle) =>
        handle
          ? handle.driver.filterIgnoredPaths(cwd, relativePaths).pipe(
              Effect.map((paths) => [...paths]),
              Effect.catch(() => Effect.succeed(relativePaths)),
            )
          : Effect.succeed(relativePaths),
      ),
      Effect.catch(() => Effect.succeed(relativePaths)),
    );

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd): Effect.fn.Return<string | null> {
    const projectRootOption = yield* platformErrorToNone(fileSystem.realPath(cwd));
    if (Option.isNone(projectRootOption)) {
      return null;
    }

    const projectRoot = projectRootOption.value;
    const shouldFilterWithVcsIgnore = yield* isInsideVcsWorkTree(projectRoot);
    const lookup = {
      fileSystem,
      projectRoot,
      filterAllowedPaths: makeAllowedPathFilter(projectRoot, shouldFilterWithVcsIgnore, (paths) =>
        filterVcsIgnoredPaths(projectRoot, paths),
      ),
    } satisfies FaviconLookupServices;

    const rootFaviconOption = yield* findFaviconInSearchRoot(lookup, projectRoot);
    if (Option.isSome(rootFaviconOption)) {
      return rootFaviconOption.value;
    }

    const nestedFaviconOption = yield* findNestedFavicon(lookup);
    if (Option.isSome(nestedFaviconOption)) {
      return nestedFaviconOption.value;
    }

    return null;
  });

  return {
    resolvePath,
  } satisfies ProjectFaviconResolverShape;
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
