import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";

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
  const workspacePaths = yield* WorkspacePaths;

  const resolveIconHref = (href: string): string[] => {
    const clean = href.replace(/^\//, "");
    return [path.join("public", clean), clean];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: projectCwd,
          relativePath,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (!candidate) {
        continue;
      }
      const stats = yield* fileSystem
        .stat(candidate.absolutePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (stats?.type === "File") {
        return candidate.absolutePath;
      }
    }
    return null;
  });

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd: string): Effect.fn.Return<string | null> {
    const projectCwd = yield* workspacePaths
      .normalizeWorkspaceRoot(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (!projectCwd) {
      return null;
    }
    for (const candidate of FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(projectCwd, [candidate]);
      if (existing) {
        return existing;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: projectCwd,
          relativePath: sourceFile,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (!sourcePath) {
        continue;
      }
      const source = yield* fileSystem
        .readFileString(sourcePath.absolutePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!source) {
        continue;
      }
      const href = extractIconHref(source);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(projectCwd, resolveIconHref(href));
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
