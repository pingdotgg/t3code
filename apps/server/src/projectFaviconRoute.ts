import http from "node:http";
import path from "node:path";

import { Array, Effect, FileSystem, Option, Result } from "effect";
import * as PlatformError from "effect/PlatformError";
import { filterGitIgnoredPaths, isInsideGitWorkTree } from "./gitIgnore";
import { isPathInIgnoredWorkspaceDirectory } from "./workspaceIgnore";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

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
];

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

type ExistingPathType = "File" | "Directory";

interface FaviconLookupServices {
  fileSystem: FileSystem.FileSystem;
  projectRoot: string;
  filterAllowedPaths: (candidatePaths: readonly string[]) => Effect.Effect<string[]>;
}

function extractIconHref(source: string): Option.Option<string> {
  return Option.firstSomeOf([
    Option.fromNullishOr(source.match(LINK_ICON_HTML_RE)?.[1]),
    Option.fromNullishOr(source.match(LINK_ICON_OBJ_RE)?.[1]),
  ]);
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
    // Reject symlinks or traversals that escape the requested project root.
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

function makeAllowedPathFilter(projectRoot: string, shouldFilterWithGitIgnore: boolean) {
  const gitIgnorePathCache = new Map<string, boolean>();

  return (candidatePaths: readonly string[]) =>
    Effect.gen(function* () {
      if (!shouldFilterWithGitIgnore || candidatePaths.length === 0) {
        return [...candidatePaths];
      }

      const uncachedRelativePaths = Array.dedupe(
        candidatePaths.flatMap((candidatePath) =>
          Option.match(toProjectRelativePath(projectRoot, candidatePath), {
            onNone: () => [],
            onSome: (relativePath) => (gitIgnorePathCache.has(relativePath) ? [] : [relativePath]),
          }),
        ),
      );

      if (uncachedRelativePaths.length > 0) {
        // Cache git-ignore decisions by normalized relative path so repeated root
        // and nested scans only hit `git check-ignore` once per candidate.
        const allowedRelativePaths = yield* Effect.promise(() =>
          filterGitIgnoredPaths(projectRoot, uncachedRelativePaths),
        ).pipe(Effect.orElseSucceed(() => uncachedRelativePaths));
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

function findFirstReadableFavicon(
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
        return Option.some({
          body: fileOption.value.content,
          contentType:
            FAVICON_MIME_TYPES[path.extname(fileOption.value.path).toLowerCase()] ??
            "application/octet-stream",
        });
      }
    }

    return Option.none();
  });
}

function iconHrefCandidatePaths(searchRoot: string, href: string): string[] {
  // Treat root-relative hrefs as app-relative because different toolchains place
  // runtime-served assets in either `public/` or directly beside the app entrypoint.
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

    return yield* findFirstReadableFavicon(
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
    return yield* Effect.findFirstFilter(sourcePaths, (sourcePath) =>
      findFaviconFromSourcePath(lookup, searchRoot, sourcePath).pipe(
        Effect.map((option) => Result.fromOption(option, () => undefined)),
      ),
    );
  });
}

function findFaviconInSearchRoot(lookup: FaviconLookupServices, searchRoot: string) {
  return Effect.gen(function* () {
    const faviconOption = yield* findFirstReadableFavicon(
      lookup,
      FAVICON_CANDIDATES.map((candidate) => path.join(searchRoot, candidate)),
    );
    if (Option.isSome(faviconOption)) {
      return faviconOption;
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

    const entries = entriesOption.value;
    const directories: string[] = [];

    for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
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
    // Prefer conventional monorepo roots first, then fall back to other top-level children.
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
    return yield* Effect.findFirstFilter(searchRoots, (searchRoot) =>
      findFaviconInSearchRoot(lookup, searchRoot).pipe(
        Effect.map((option) => Result.fromOption(option, () => undefined)),
      ),
    );
  });
}

function respond(
  res: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: Uint8Array | string,
  cacheable = true,
) {
  return Effect.sync(() => {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
    };
    if (cacheable) {
      headers["Cache-Control"] = "public, max-age=3600";
    }
    res.writeHead(statusCode, headers);
    res.end(body);
  });
}

function respondWithFavicon(
  res: http.ServerResponse,
  favicon: {
    body: Uint8Array;
    contentType: string;
  },
) {
  return respond(res, 200, favicon.contentType, favicon.body);
}

function respondWithFallbackFavicon(res: http.ServerResponse) {
  return respond(res, 200, "image/svg+xml", FALLBACK_FAVICON_SVG);
}

export function tryHandleProjectFaviconRequest(
  url: URL,
  res: http.ServerResponse,
): Effect.Effect<boolean, never, FileSystem.FileSystem> {
  if (url.pathname !== "/api/project-favicon") {
    return Effect.succeed(false);
  }

  const projectCwd = url.searchParams.get("cwd");
  if (!projectCwd) {
    return Effect.sync(() => {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing cwd parameter");
      return true;
    });
  }

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const projectRootOption = yield* platformErrorToNone(fileSystem.realPath(projectCwd));
    if (Option.isNone(projectRootOption)) {
      yield* respondWithFallbackFavicon(res);
      return true;
    }

    const projectRoot = projectRootOption.value;
    const shouldFilterWithGitIgnore = yield* Effect.promise(() =>
      isInsideGitWorkTree(projectRoot).catch(() => false),
    );
    const lookup = {
      fileSystem,
      projectRoot,
      filterAllowedPaths: makeAllowedPathFilter(projectRoot, shouldFilterWithGitIgnore),
    } satisfies FaviconLookupServices;

    const rootFaviconOption = yield* findFaviconInSearchRoot(lookup, projectRoot);
    if (Option.isSome(rootFaviconOption)) {
      yield* respondWithFavicon(res, rootFaviconOption.value);
      return true;
    }

    const nestedFaviconOption = yield* findNestedFavicon(lookup);
    if (Option.isSome(nestedFaviconOption)) {
      yield* respondWithFavicon(res, nestedFaviconOption.value);
      return true;
    }

    yield* respondWithFallbackFavicon(res);
    return true;
  });
}
