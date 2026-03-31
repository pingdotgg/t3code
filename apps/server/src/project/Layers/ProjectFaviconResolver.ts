import { Effect, FileSystem, Layer, Path } from "effect";

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

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveIconHref = (projectCwd: string, href: string): string[] => {
    const clean = href.replace(/^\//, "");
    return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
  };

  const isPathWithinProject = (projectCwd: string, candidatePath: string): boolean => {
    const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    candidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null> {
    for (const candidate of candidates) {
      if (!isPathWithinProject(projectCwd, candidate)) {
        continue;
      }
      const stats = yield* fileSystem
        .stat(candidate)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (stats?.type === "File") {
        return candidate;
      }
    }
    return null;
  });

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd: string): Effect.fn.Return<string | null> {
    for (const candidate of FAVICON_CANDIDATES) {
      const resolved = path.join(cwd, candidate);
      const existing = yield* findExistingFile(cwd, [resolved]);
      if (existing) {
        return existing;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = path.join(cwd, sourceFile);
      const source = yield* fileSystem
        .readFileString(sourcePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!source) {
        continue;
      }
      const href = extractIconHref(source);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(cwd, resolveIconHref(cwd, href));
      if (existing) {
        return existing;
      }
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
