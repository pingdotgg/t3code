import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const FAVICON_CACHE_CAPACITY = 512;
const FAVICON_POSITIVE_CACHE_TTL = Duration.minutes(10);
const FAVICON_NEGATIVE_CACHE_TTL = Duration.minutes(1);

function faviconCacheKey(cwd: string, faviconPath?: string): string {
  return `${faviconPath ?? ""}\0${cwd}`;
}

function parseFaviconCacheKey(key: string): {
  readonly cwd: string;
  readonly faviconPath?: string;
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return { cwd: key };
  }
  const faviconPath = key.slice(0, separatorIndex);
  const cwd = key.slice(separatorIndex + 1);
  return faviconPath.length === 0 ? { cwd } : { cwd, faviconPath };
}

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
  "Resources/AppIcon.icns",
  "AppIcon.icns",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Anchor HTML at <link and scan brace-free metadata runs to avoid quadratic regex rescans.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

// Projects without a web icon are probed on every cached miss, so the app icon search stays
// shallow and bounded. Three levels below the root covers ios/App/App and apps/ios/<target>.
const APP_ICON_SEARCH_DEPTH = 3;
const APP_ICON_SEARCH_READ_LIMIT = 256;
const APP_ICON_SEARCH_SKIPPED_DIRECTORIES = new Set([
  "build",
  "Carthage",
  "DerivedData",
  "dist",
  "node_modules",
  "Pods",
  "vendor",
]);
const APP_EXTENSION_TARGET_RE = /(?:clip|extension|tests?|watch|widget)[^/\\]*[/\\]/i;
// Asset catalogs list icons up to 1024px; the smallest sharp one keeps the transfer small.
const APP_ICON_SHARP_PIXELS = 96;

const ExpoConfig = Schema.Struct({
  android: Schema.optional(Schema.Struct({ icon: Schema.optional(Schema.String) })),
  icon: Schema.optional(Schema.String),
  ios: Schema.optional(
    Schema.Struct({
      icon: Schema.optional(
        Schema.Union([Schema.String, Schema.Struct({ light: Schema.optional(Schema.String) })]),
      ),
    }),
  ),
});

// Expo also accepts its config at the root of app.json, without the `expo` wrapper.
const decodeExpoAppConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ...ExpoConfig.fields, expo: Schema.optional(ExpoConfig) })),
);

// Densities run from the first at least 96px wide, matching APP_ICON_SHARP_PIXELS.
// Adaptive icons are XML plus separate layers, so only flattened launcher images qualify.
const ANDROID_ICON_CANDIDATES = ["android/app", "app"].flatMap((module) =>
  ["xhdpi", "xxhdpi", "xxxhdpi", "hdpi", "mdpi"].flatMap((density) =>
    ["png", "webp"].map(
      (extension) => `${module}/src/main/res/mipmap-${density}/ic_launcher.${extension}`,
    ),
  ),
);

const decodeAppIconSetContents = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      images: Schema.Array(
        Schema.Struct({
          appearances: Schema.optional(Schema.Array(Schema.Unknown)),
          filename: Schema.optional(Schema.String),
          scale: Schema.optional(Schema.String),
          size: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

function appIconFilenames(contents: string): ReadonlyArray<string> {
  const decoded = decodeAppIconSetContents(contents);
  if (Option.isNone(decoded)) return [];
  const icons = decoded.value.images.flatMap(({ appearances, filename, scale, size }) =>
    filename === undefined || (appearances?.length ?? 0) > 0
      ? []
      : [{ filename, pixels: (parseFloat(size ?? "") || 0) * (parseFloat(scale ?? "") || 1) }],
  );
  const sharp = icons.filter((icon) => icon.pixels >= APP_ICON_SHARP_PIXELS);
  const small = icons.filter((icon) => icon.pixels < APP_ICON_SHARP_PIXELS);
  return [
    ...sharp.toSorted((left, right) => left.pixels - right.pixels),
    ...small.toSorted((left, right) => right.pixels - left.pixels),
  ].map((icon) => icon.filename);
}

function appIconSetRank(relativePath: string, setName: string): number {
  return (
    (APP_EXTENSION_TARGET_RE.test(relativePath) ? 2 : 0) +
    (setName === "AppIcon.appiconset" ? 0 : 1)
  );
}

export class ProjectFaviconResolutionError extends Schema.TaggedError<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
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

const isWorkspaceRootNotExistsError = Schema.is(WorkspacePaths.WorkspaceRootNotExistsError);

export const isMissingWorkspaceRoot = (error: ProjectFaviconResolutionError): boolean =>
  error.operation === "normalize-workspace" && isWorkspaceRootNotExistsError(error.cause);

export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    readonly resolvePath: (
      cwd: string,
      faviconPath?: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
    /** Forgets cached lookups for a workspace whose files changed, such as a finished clone. */
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/project/ProjectFaviconResolver") {}

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

export const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.asSome,
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
        Effect.asSome,
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

  const findIconFromSource = Effect.fn("ProjectFaviconResolver.findIconFromSource")(function* (
    projectCwd: string,
    sourceFile: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
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
    const source = yield* optionOnNotFound(fileSystem.readFileString(sourcePath.absolutePath)).pipe(
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
      return null;
    }
    const href = extractIconHref(source.value);
    if (!href) {
      return null;
    }
    return yield* findExistingFile(projectCwd, resolveIconHref(href), "workspace");
  });

  const readFileIfReadable = (absolutePath: string) =>
    fileSystem.readFileString(absolutePath).pipe(Effect.orElseSucceed(() => null));

  const readDirectoryIfReadable = (absolutePath: string) =>
    fileSystem.readDirectory(absolutePath).pipe(
      Effect.map((entries) => entries.toSorted()),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const findExpoIcon = Effect.fn("ProjectFaviconResolver.findExpoIcon")(function* (
    projectCwd: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const source = yield* readFileIfReadable(path.join(projectCwd, "app.json"));
    if (source === null) return null;
    const config = decodeExpoAppConfig(source);
    if (Option.isNone(config)) return null;
    const { android, icon, ios } = config.value.expo ?? config.value;
    const iosIcon = typeof ios?.icon === "string" ? ios.icon : ios?.icon?.light;
    return yield* findExistingFile(
      projectCwd,
      [iosIcon, icon, android?.icon].filter((candidate) => candidate !== undefined),
      "workspace",
    );
  });

  const findIconInAppIconSets = Effect.fn("ProjectFaviconResolver.findIconInAppIconSets")(
    function* (
      projectCwd: string,
      catalogs: ReadonlyArray<string>,
      takeReads: <A>(items: ReadonlyArray<A>) => ReadonlyArray<A>,
    ) {
      const sets: Array<{ readonly relativePath: string; readonly rank: number }> = [];
      for (const catalog of takeReads(catalogs)) {
        const entries = yield* readDirectoryIfReadable(path.join(projectCwd, catalog));
        for (const entry of entries) {
          if (entry.endsWith(".appiconset")) {
            const relativePath = path.join(catalog, entry);
            sets.push({ relativePath, rank: appIconSetRank(relativePath, entry) });
          }
        }
      }
      for (const { relativePath } of takeReads(
        sets.toSorted((left, right) => left.rank - right.rank),
      )) {
        const contents = yield* readFileIfReadable(
          path.join(projectCwd, relativePath, "Contents.json"),
        );
        const found = yield* findExistingFile(
          projectCwd,
          takeReads(appIconFilenames(contents ?? "")).map((filename) =>
            path.join(relativePath, filename),
          ),
          "workspace",
        );
        if (found) return found;
      }
      return null;
    },
  );

  // Breadth first, so the catalogs closest to the root win and deeper levels are never read.
  const findAppIcon = Effect.fn("ProjectFaviconResolver.findAppIcon")(function* (
    projectCwd: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    let directories: ReadonlyArray<string> = [""];
    let remainingReads = APP_ICON_SEARCH_READ_LIMIT;
    const takeReads = <A>(items: ReadonlyArray<A>) => {
      const taken = items.slice(0, remainingReads);
      remainingReads -= taken.length;
      return taken;
    };
    for (let depth = 0; depth <= APP_ICON_SEARCH_DEPTH; depth += 1) {
      const catalogs: Array<string> = [];
      const nextDirectories: Array<string> = [];
      for (const directory of takeReads(directories)) {
        const entries = yield* readDirectoryIfReadable(path.join(projectCwd, directory));
        for (const entry of entries) {
          if (entry.endsWith(".xcassets")) {
            catalogs.push(path.join(directory, entry));
          } else if (
            // Directory reads have no file types, and most entries with an extension are files.
            path.extname(entry) === "" &&
            !entry.startsWith(".") &&
            !APP_ICON_SEARCH_SKIPPED_DIRECTORIES.has(entry)
          ) {
            nextDirectories.push(path.join(directory, entry));
          }
        }
      }
      const found = yield* findIconInAppIconSets(projectCwd, catalogs, takeReads);
      if (found) return found;
      directories = nextDirectories;
    }
    return null;
  });

  // Probe concurrently but join in list order so lower-ranked probes cannot delay a hit.
  // A failure surfaces only if no earlier probe found a file; scope exit interrupts remaining probes.
  const firstInOrder = Effect.fn("ProjectFaviconResolver.firstInOrder")(function* <A>(
    items: ReadonlyArray<A>,
    probe: (item: A) => Effect.Effect<string | null, ProjectFaviconResolutionError>,
  ) {
    const fibers = yield* Effect.forEach(items, (item) => Effect.forkScoped(probe(item)));
    for (const fiber of fibers) {
      const found = yield* Fiber.join(fiber);
      if (found) {
        return found;
      }
    }
    return null;
  }, Effect.scoped);

  const resolvePathUncached = Effect.fn("ProjectFaviconResolver.resolvePathUncached")(function* (
    cwd: string,
    faviconPath?: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
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
    if (faviconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [faviconPath], "filesystem");
      if (existing) {
        return existing;
      }
    }

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

    const wellKnown = yield* firstInOrder(FAVICON_CANDIDATES, (candidate) =>
      findExistingFile(projectCwd, [candidate], "workspace"),
    );
    if (wellKnown) {
      return wellKnown;
    }

    const fromSource = yield* firstInOrder(ICON_SOURCE_FILES, (sourceFile) =>
      findIconFromSource(projectCwd, sourceFile),
    );
    if (fromSource) {
      return fromSource;
    }

    return (
      (yield* findExpoIcon(projectCwd)) ??
      (yield* findAppIcon(projectCwd)) ??
      (yield* firstInOrder(ANDROID_ICON_CANDIDATES, (candidate) =>
        findExistingFile(projectCwd, [candidate], "workspace"),
      ))
    );
  });

  const faviconCache = yield* Cache.makeWith<string, string | null, ProjectFaviconResolutionError>(
    (key) => {
      const { cwd, faviconPath } = parseFaviconCacheKey(key);
      return resolvePathUncached(cwd, faviconPath);
    },
    {
      capacity: FAVICON_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value: string | null) =>
          value === null ? FAVICON_NEGATIVE_CACHE_TTL : FAVICON_POSITIVE_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd, faviconPath) {
    const key = faviconCacheKey(cwd, faviconPath);
    const cached = yield* Cache.get(faviconCache, key);
    if (cached === null) {
      return null;
    }

    const stats = yield* optionOnNotFound(fileSystem.stat(cached)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "stat-candidate",
            workspaceRoot: cwd,
            absolutePath: cached,
            cause,
          }),
      ),
    );
    if (Option.isSome(stats) && stats.value.type === "File") {
      return cached;
    }

    yield* Cache.invalidate(faviconCache, key);
    return yield* Cache.get(faviconCache, key);
  });

  const invalidate: ProjectFaviconResolver["Service"]["invalidate"] = (cwd) =>
    Cache.keys(faviconCache).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(
          Array.from(keys).filter((key) => parseFaviconCacheKey(key).cwd === cwd),
          (key) => Cache.invalidate(faviconCache, key),
          { discard: true },
        ),
      ),
    );

  return ProjectFaviconResolver.of({ resolvePath, invalidate });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
