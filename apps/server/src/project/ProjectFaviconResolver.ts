/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

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

// Manifest files that may declare PWA icons.
const MANIFEST_SOURCE_FILES = [
  "manifest.json",
  "public/manifest.json",
  "site.webmanifest",
  "public/site.webmanifest",
] as const;

// Directories scanned as a fallback for common icon filenames.
const IMAGE_DIR_CANDIDATES = [
  "",
  "public",
  "app",
  "src",
  "src/app",
  "assets",
  "src/assets",
  "assets/icons",
  "assets/icon",
  "static",
  "resources",
  "images",
  "img",
  "media",
  "app-icon",
  ".idea",
] as const;

const IMAGE_NAME_CANDIDATES = [
  "favicon",
  "icon",
  "logo",
  "apple-touch-icon",
  "app-icon",
  "icon-rounded",
  "brand",
  "app",
] as const;

const IMAGE_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
// The tag pattern is anchored on `<link`, so it only starts at real candidates. Object metadata
// is matched by scanning brace-free runs instead of by one combined pattern: an unanchored
// pattern restarts at every offset and rescans forward, which is quadratic on large sources.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export class ProjectFaviconResolutionError extends Schema.TaggedErrorClass<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
      "read-manifest",
      "scan-directory",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/** Service tag for project favicon resolution. */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    /**
     * Resolve a favicon or icon file path for the provided workspace root.
     *
     * Returns `null` when no candidate icon file can be found.
     */
    readonly resolvePath: (
      cwd: string,
      faviconPath?: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
  }
>()("t3/project/ProjectFaviconResolver") {}

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  // Icon metadata counts when `rel` and `href` share a brace-free run, so a run holding `rel`
  // but no href falls through to the next one rather than ending the search.
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

function parseIconSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  let maxSize = 0;
  for (const part of sizes.split(/\s+/)) {
    const match = part.match(/^(\d+)x\d+$/);
    if (match) {
      maxSize = Math.max(maxSize, Number(match[1]));
    }
  }
  return maxSize;
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const resolveIconHref = (href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [path.join("public", clean), clean];
  };

  const toPosixRelativePath = (input: string): string => input.replaceAll("\\", "/");

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
    candidateScope: "workspace" | "filesystem",
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* (
        candidateScope === "filesystem" && path.isAbsolute(relativePath)
          ? Effect.succeed({ absolutePath: relativePath, relativePath })
          : workspacePaths.resolveRelativePathWithinRoot({
              workspaceRoot: projectCwd,
              relativePath,
            })
      ).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            Effect.succeed(
              Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
            ),
        }),
      );
      if (Option.isNone(candidate)) {
        continue;
      }
      const stats = yield* optionOnNotFound(fileSystem.stat(candidate.value.absolutePath)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot: projectCwd,
              relativePath,
              absolutePath: candidate.value.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isSome(stats) && stats.value.type === "File") {
        return candidate.value.absolutePath;
      }
    }
    return null;
  });

  const findBestIconInDirectory = Effect.fn("ProjectFaviconResolver.findBestIconInDirectory")(
    function* (
      projectCwd: string,
      dir: string,
      candidatePriority: ReadonlyMap<
        string,
        { readonly dirIdx: number; readonly nameIdx: number; readonly extIdx: number }
      >,
    ): Effect.fn.Return<
      {
        readonly absolutePath: string;
        readonly relativePath: string;
        readonly priority: {
          readonly dirIdx: number;
          readonly nameIdx: number;
          readonly extIdx: number;
        };
      } | null,
      ProjectFaviconResolutionError
    > {
      const absoluteDir = path.resolve(projectCwd, dir);
      const relativeToRoot = toPosixRelativePath(path.relative(projectCwd, absoluteDir));
      if (
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return null;
      }

      const entries = yield* Effect.option(fileSystem.readDirectory(absoluteDir));
      if (Option.isNone(entries)) return null;

      let best: {
        readonly absolutePath: string;
        readonly relativePath: string;
        readonly priority: {
          readonly dirIdx: number;
          readonly nameIdx: number;
          readonly extIdx: number;
        };
      } | null = null;

      for (const entry of entries.value) {
        const key = dir ? `${dir}/${entry}` : entry;
        const priority = candidatePriority.get(key);
        if (!priority) continue;

        const absolutePath = path.join(absoluteDir, entry);
        const relativePath = dir ? path.join(dir, entry) : entry;
        const stats = yield* Effect.option(fileSystem.stat(absolutePath));
        if (Option.isNone(stats) || stats.value.type !== "File") continue;

        if (
          !best ||
          priority.dirIdx < best.priority.dirIdx ||
          (priority.dirIdx === best.priority.dirIdx && priority.nameIdx < best.priority.nameIdx) ||
          (priority.dirIdx === best.priority.dirIdx &&
            priority.nameIdx === best.priority.nameIdx &&
            priority.extIdx < best.priority.extIdx)
        ) {
          best = { absolutePath, relativePath, priority };
        }
      }

      return best;
    },
  );

  const findIconByDirectoryScan = Effect.fn("ProjectFaviconResolver.findIconByDirectoryScan")(
    function* (projectCwd: string): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
      const candidatePriority = new Map<
        string,
        { readonly dirIdx: number; readonly nameIdx: number; readonly extIdx: number }
      >();
      IMAGE_DIR_CANDIDATES.forEach((candidateDir, dirIdx) => {
        IMAGE_NAME_CANDIDATES.forEach((name, nameIdx) => {
          IMAGE_EXTENSIONS.forEach((ext, extIdx) => {
            const key = candidateDir ? `${candidateDir}/${name}${ext}` : `${name}${ext}`;
            candidatePriority.set(key, { dirIdx, nameIdx, extIdx });
          });
        });
      });

      let best: {
        readonly absolutePath: string;
        readonly relativePath: string;
        readonly priority: {
          readonly dirIdx: number;
          readonly nameIdx: number;
          readonly extIdx: number;
        };
      } | null = null;

      for (const candidateDir of IMAGE_DIR_CANDIDATES) {
        const match = yield* findBestIconInDirectory(projectCwd, candidateDir, candidatePriority);
        if (!match) continue;
        if (
          !best ||
          match.priority.dirIdx < best.priority.dirIdx ||
          (match.priority.dirIdx === best.priority.dirIdx &&
            match.priority.nameIdx < best.priority.nameIdx) ||
          (match.priority.dirIdx === best.priority.dirIdx &&
            match.priority.nameIdx === best.priority.nameIdx &&
            match.priority.extIdx < best.priority.extIdx)
        ) {
          best = match;
        }
      }

      return best ? best.absolutePath : null;
    },
  );

  const resolveManifestIcon = Effect.fn("ProjectFaviconResolver.resolveManifestIcon")(function* (
    projectCwd: string,
    relativePath: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const sourcePath = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: projectCwd,
        relativePath,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "resolve-path",
              workspaceRoot: projectCwd,
              relativePath,
              cause,
            }),
        ),
      );
    const source = yield* optionOnNotFound(fileSystem.readFileString(sourcePath.absolutePath)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "read-manifest",
            workspaceRoot: projectCwd,
            relativePath,
            absolutePath: sourcePath.absolutePath,
            cause,
          }),
      ),
    );
    if (Option.isNone(source)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(source.value);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const manifest = parsed as { icons?: ReadonlyArray<{ src?: string; sizes?: string }> };
    if (!Array.isArray(manifest.icons)) return null;

    let bestIcon: string | null = null;
    let bestSize = -1;
    for (const icon of manifest.icons) {
      if (typeof icon.src !== "string") continue;
      const existing = yield* findExistingFile(projectCwd, resolveIconHref(icon.src));
      if (!existing) continue;
      const size = parseIconSize(icon.sizes);
      if (size > bestSize) {
        bestIcon = existing;
        bestSize = size;
      }
    }
    return bestIcon;
  });

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd, faviconPath) {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    // A grouped project's saved path can be absent from one checkout. Use it
    // where it exists and retain automatic discovery for the other checkouts.
    if (faviconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [faviconPath], "filesystem");
      if (existing) {
        return existing;
      }
    }

    // A t3.json iconPath takes precedence over the well-known locations.
    const projectFile = yield* projectFileLoader.load(projectCwd);
    if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
      const existing = yield* findExistingFile(
        projectCwd,
        [projectFile.value.iconPath],
        "workspace",
      );
      if (existing) {
        return existing;
      }
    }

    for (const candidate of FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(projectCwd, [candidate], "workspace");
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
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectFaviconResolutionError({
                operation: "resolve-path",
                workspaceRoot: projectCwd,
                relativePath: sourceFile,
                cause,
              }),
          ),
        );
      const source = yield* optionOnNotFound(
        fileSystem.readFileString(sourcePath.absolutePath),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "read-source",
              workspaceRoot: projectCwd,
              relativePath: sourceFile,
              absolutePath: sourcePath.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isNone(source)) {
        continue;
      }
      const href = extractIconHref(source.value);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(projectCwd, resolveIconHref(href), "workspace");
      if (existing) {
        return existing;
      }
    }

    for (const manifestFile of MANIFEST_SOURCE_FILES) {
      const existing = yield* resolveManifestIcon(projectCwd, manifestFile);
      if (existing) {
        return existing;
      }
    }

    const scanned = yield* findIconByDirectoryScan(projectCwd);
    if (scanned) {
      return scanned;
    }

    return null;
  });

  return ProjectFaviconResolver.of({ resolvePath });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
