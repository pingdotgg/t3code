/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata. Monorepo roots
 * (Turborepo and friends) keep their icons inside a workspace package, so the
 * same locations are checked again in each `apps/*` and `packages/*` directory.
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

// Directories holding workspace packages in a conventional monorepo layout.
const MONOREPO_PACKAGE_DIRECTORIES = ["apps", "packages"] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

export class ProjectFaviconResolutionError extends Schema.TaggedErrorClass<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
      "list-packages",
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
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
  }
>()("t3/project/ProjectFaviconResolver") {}

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
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

  const withinPackage = (packageDir: string, relativePath: string) =>
    packageDir ? `${packageDir}/${relativePath}` : relativePath;

  const resolveIconHref = (packageDir: string, href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [
      withinPackage(packageDir, path.join("public", clean)),
      withinPackage(packageDir, clean),
    ];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: projectCwd,
          relativePath,
        })
        .pipe(
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

  /**
   * Check the well-known icon locations inside one directory of the project.
   * `packageDir` is `""` for the project root, or a workspace-relative package
   * directory such as `apps/web`.
   */
  const findIconWithin = Effect.fn("ProjectFaviconResolver.findIconWithin")(function* (
    projectCwd: string,
    packageDir: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const candidate of FAVICON_CANDIDATES) {
      const existing = yield* findExistingFile(projectCwd, [withinPackage(packageDir, candidate)]);
      if (existing) {
        return existing;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const relativePath = withinPackage(packageDir, sourceFile);
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
      const source = yield* optionOnNotFound(
        fileSystem.readFileString(sourcePath.absolutePath),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "read-source",
              workspaceRoot: projectCwd,
              relativePath,
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
      const existing = yield* findExistingFile(projectCwd, resolveIconHref(packageDir, href));
      if (existing) {
        return existing;
      }
    }

    return null;
  });

  /**
   * List the workspace package directories of a conventional monorepo, sorted
   * within each parent. Parents that do not exist are skipped; other failures
   * surface, matching how the well-known candidates are checked.
   */
  const findPackageDirectories = Effect.fn("ProjectFaviconResolver.findPackageDirectories")(
    function* (
      projectCwd: string,
    ): Effect.fn.Return<ReadonlyArray<string>, ProjectFaviconResolutionError> {
      const directories: Array<string> = [];
      for (const parent of MONOREPO_PACKAGE_DIRECTORIES) {
        const parentPath = path.join(projectCwd, parent);
        const entries = yield* optionOnNotFound(fileSystem.readDirectory(parentPath)).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectFaviconResolutionError({
                operation: "list-packages",
                workspaceRoot: projectCwd,
                relativePath: parent,
                absolutePath: parentPath,
                cause,
              }),
          ),
        );
        if (Option.isNone(entries)) {
          continue;
        }
        for (const entry of [...entries.value].sort()) {
          const absolutePath = path.join(parentPath, entry);
          const stats = yield* optionOnNotFound(fileSystem.stat(absolutePath)).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectFaviconResolutionError({
                  operation: "list-packages",
                  workspaceRoot: projectCwd,
                  relativePath: `${parent}/${entry}`,
                  absolutePath,
                  cause,
                }),
            ),
          );
          if (Option.isSome(stats) && stats.value.type === "Directory") {
            directories.push(`${parent}/${entry}`);
          }
        }
      }
      return directories;
    },
  );

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd) {
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
    // A t3.json iconPath takes precedence over the well-known locations.
    const projectFile = yield* projectFileLoader.load(projectCwd);
    if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [projectFile.value.iconPath]);
      if (existing) {
        return existing;
      }
    }

    const rootIcon = yield* findIconWithin(projectCwd, "");
    if (rootIcon) {
      return rootIcon;
    }

    // Monorepo roots rarely carry an icon of their own; fall back to the
    // workspace packages, apps before packages.
    for (const packageDir of yield* findPackageDirectories(projectCwd)) {
      const packageIcon = yield* findIconWithin(projectCwd, packageDir);
      if (packageIcon) {
        return packageIcon;
      }
    }

    return null;
  });

  return ProjectFaviconResolver.of({ resolvePath });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
