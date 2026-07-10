import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetPreviewTypeValidationError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  AssetWorkspaceResolutionError,
  AssetWorkspaceRootNormalizationError,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";
export const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const NEXTJS_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-nextjs"><circle cx="64" cy="64" r="64" fill="#000"/><path d="M106.5 110.6 49.2 38H38v52h9.5V49.9l52.8 66.2c2.2-1.7 4.2-3.5 6.2-5.5Z" fill="#fff"/><path d="M81 38h9v52h-9z" fill="url(#ng)"/><defs><linearGradient id="ng" x1="85.5" y1="38" x2="85.5" y2="90" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>`;
const REACT_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-11.5 -10.23174 23 20.46348" data-fallback="project-favicon-react"><circle cx="0" cy="0" r="2.05" fill="#61dafb"/><g fill="none" stroke="#61dafb" stroke-width="1"><ellipse rx="11" ry="4.2"/><ellipse rx="11" ry="4.2" transform="rotate(60)"/><ellipse rx="11" ry="4.2" transform="rotate(120)"/></g></svg>`;
const VUE_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-vue"><path fill="#41b883" d="M78.8 10 64 35.4 49.2 10H0l64 108L128 10z"/><path fill="#35495e" d="M78.8 10 64 35.4 49.2 10H25.6L64 76l38.4-66z"/></svg>`;
const SVELTE_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-svelte"><path d="M110.3 26.3C99 10.1 77 5.5 60.9 15.6L27.5 36.4C19.8 41 14.4 48.5 12.8 57.1c-1.4 7.2-.2 14.7 3.4 21.1a31.5 31.5 0 0 0-4.7 11.9c-1.6 8.9.6 18 6.1 25.1C28.9 131.4 51 136 67.1 125.9l33.4-20.8c7.7-4.6 13.1-12.1 14.7-20.7 1.4-7.2.2-14.7-3.4-21.1a31.5 31.5 0 0 0 4.7-11.9c1.6-8.9-.6-18-6.2-25.1z" fill="#ff3e00"/><path d="M59.4 109.8c-9.6 2.6-19.9-1.3-25.2-9.6a23.5 23.5 0 0 1-3.3-14.2c.2-1.3.5-2.5.9-3.7l.7-2.1 1.8 1.4a47 47 0 0 0 14.3 7.2l1.4.4-.1 1.4a7.2 7.2 0 0 0 1.3 4.6c1.8 2.6 5 3.8 8 3a7.4 7.4 0 0 0 2-.9L93.8 75c1.9-1.1 3.2-3 3.4-5.1.3-2.2-.6-4.4-2.3-5.8a7.2 7.2 0 0 0-7.9-.8l-.1.1-13.4 8.3a24.6 24.6 0 0 1-6.7 3 23.8 23.8 0 0 1-25.2-9.6 23.5 23.5 0 0 1-3.3-14.2 22 22 0 0 1 9.9-16l33.4-20.8a24.6 24.6 0 0 1 6.7-3c9.6-2.6 19.9 1.3 25.2 9.6a23.5 23.5 0 0 1 3.3 14.2c-.2 1.3-.5 2.5-.9 3.7l-.7 2.1-1.8-1.4a47 47 0 0 0-14.3-7.2l-1.4-.4.1-1.4a7.2 7.2 0 0 0-1.3-4.6c-1.8-2.6-5-3.8-8-3a7.4 7.4 0 0 0-2 .9L34.2 53c-1.9 1.1-3.2 3-3.4 5.1-.3 2.2.6 4.4 2.3 5.8a7.2 7.2 0 0 0 7.9.8l.1-.1 13.4-8.3a24.6 24.6 0 0 1 6.7-3 23.8 23.8 0 0 1 25.2 9.6 23.5 23.5 0 0 1 3.3 14.2 22 22 0 0 1-9.9 16L46.4 113.9a24.6 24.6 0 0 1-7 3z" fill="#fff"/></svg>`;
const ANGULAR_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-angular"><path fill="#dd0031" d="M64 4 8.6 23.8l8.3 69.9L64 124l47.1-30.3 8.3-69.9z"/><path fill="#c3002f" d="M64 4v120l47.1-30.3 8.3-69.9z"/><path fill="#fff" d="m64 21.1-28 63.9h10.4l5.6-14.2h24l5.6 14.2H92L64 21.1zm0 20.1 9.4 21.6H54.6L64 41.2z"/></svg>`;
const ANDROID_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-android"><path stroke="#3ddc84" stroke-width="6" stroke-linecap="round" fill="none" d="M52 36L44 16M76 36L84 16"/><path fill="#3ddc84" d="M30 68A34 34 0 0 1 98 68L98 104Q98 110 92 110L36 110Q30 110 30 104Z"/><circle cx="50" cy="54" r="5.5" fill="#fff"/><circle cx="78" cy="54" r="5.5" fill="#fff"/></svg>`;
const YOUTUBE_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-youtube"><rect x="10" y="28" width="108" height="72" rx="18" fill="#ff0033"/><path d="M55 48v32l29-16-29-16Z" fill="white"/></svg>`;
const TIKTOK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-tiktok"><rect width="128" height="128" rx="24" fill="#010101"/><path d="M90 30c2 13 10 19 22 20v15c-8 0-15-2-22-7v32c0 19-14 34-33 34-8 0-16-3-22-8a33 33 0 0 1 22-58v16c-10 2-17 11-15 21 2 9 11 15 20 13 9-2 16-10 16-19V30h12Z" fill="#fff"/><path d="M88 28c2 13 10 19 22 20v15c-8 0-15-2-22-7v32c0 19-14 34-33 34-8 0-16-3-22-8a33 33 0 0 1 22-58v16c-10 2-17 11-15 21 2 9 11 15 20 13 9-2 16-10 16-19V28h12Z" fill="#69c9d0"/></svg>`;
const INSTAGRAM_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-instagram"><defs><radialGradient id="ig" cx="30%" cy="107%" r="150%"><stop offset="0%" stop-color="#fdf497"/><stop offset="10%" stop-color="#fdf497"/><stop offset="50%" stop-color="#fd5949"/><stop offset="68%" stop-color="#d6249f"/><stop offset="100%" stop-color="#285aeb"/></radialGradient></defs><rect width="128" height="128" rx="28" fill="url(#ig)"/><rect x="22" y="22" width="84" height="84" rx="22" fill="none" stroke="#fff" stroke-width="8"/><circle cx="64" cy="64" r="22" fill="none" stroke="#fff" stroke-width="8"/><circle cx="91" cy="37" r="6" fill="#fff"/></svg>`;

const ANDROID_PROJECT_MARKER_FILES = [
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
];

const YOUTUBE_PROJECT_NAME_PATTERNS = /\byt\b|youtube/i;
const TIKTOK_PROJECT_NAME_PATTERNS = /tiktok|tik[_-]?tok/i;
const INSTAGRAM_PROJECT_NAME_PATTERNS = /instagram|\binsta\b/i;

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "project-favicon-fallback"; readonly svg: string };

const PackageJsonDependenciesJson = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const decodePackageJsonDependencies = Schema.decodeUnknownOption(PackageJsonDependenciesJson);

function parsePackageJsonDependencyNames(contents: string): ReadonlySet<string> {
  const parsed = Option.getOrNull(decodePackageJsonDependencies(contents));
  return new Set([
    ...Object.keys(parsed?.dependencies ?? {}),
    ...Object.keys(parsed?.devDependencies ?? {}),
  ]);
}

// Detection failures degrade to the generic fallback icon rather than failing
// the asset request.
const resolveProjectFaviconFallbackSvg = Effect.fn("AssetAccess.resolveProjectFaviconFallbackSvg")(
  function* (workspaceRoot: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const projectName = path.basename(workspaceRoot);

    if (YOUTUBE_PROJECT_NAME_PATTERNS.test(projectName)) return YOUTUBE_PROJECT_FAVICON_SVG;
    if (TIKTOK_PROJECT_NAME_PATTERNS.test(projectName)) return TIKTOK_PROJECT_FAVICON_SVG;
    if (INSTAGRAM_PROJECT_NAME_PATTERNS.test(projectName)) return INSTAGRAM_PROJECT_FAVICON_SVG;

    const packageJsonContents = yield* fileSystem
      .readFileString(path.join(workspaceRoot, "package.json"))
      .pipe(Effect.orElseSucceed(() => null));
    if (packageJsonContents !== null) {
      const dependencyNames = parsePackageJsonDependencyNames(packageJsonContents);
      if (dependencyNames.has("next")) return NEXTJS_PROJECT_FAVICON_SVG;
      if (dependencyNames.has("@angular/core")) return ANGULAR_PROJECT_FAVICON_SVG;
      if (dependencyNames.has("svelte") || dependencyNames.has("@sveltejs/kit"))
        return SVELTE_PROJECT_FAVICON_SVG;
      if (dependencyNames.has("vue") || dependencyNames.has("nuxt")) return VUE_PROJECT_FAVICON_SVG;
      if (dependencyNames.has("react") || dependencyNames.has("react-native"))
        return REACT_PROJECT_FAVICON_SVG;
    }

    for (const markerFile of ANDROID_PROJECT_MARKER_FILES) {
      const markerExists = yield* fileSystem
        .exists(path.join(workspaceRoot, markerFile))
        .pipe(Effect.orElseSucceed(() => false));
      if (markerExists) return ANDROID_PROJECT_FAVICON_SVG;
    }

    return FALLBACK_PROJECT_FAVICON_SVG;
  },
);

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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

const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeed(Option.none()),
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value));
    return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
  },
);

const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;

  switch (input.resource._tag) {
    case "workspace-file": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({
          resource: input.resource,
        });
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = path.isAbsolute(input.resource.path)
        ? path.relative(workspaceRoot, input.resource.path)
        : input.resource.path;
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspacePathValidationError({
                resource: input.resource,
                cause,
              }),
          ),
        );
      if (!isWorkspacePreviewEntryPath(resolved.relativePath)) {
        return yield* new AssetPreviewTypeValidationError({
          resource: input.resource,
        });
      }
      const canonicalFile = yield* resolveCanonicalWorkspaceFile({
        workspaceRoot,
        relativePath: resolved.relativePath,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceAssetInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (!canonicalFile) {
        return yield* new AssetWorkspaceAssetNotFoundError({
          resource: input.resource,
        });
      }
      const canonicalWorkspaceRoot = yield* fileSystem.realPath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      claims = isWorkspaceImagePreviewPath(resolved.relativePath)
        ? {
            version: 1,
            kind: "workspace-file-exact",
            workspaceRoot: canonicalWorkspaceRoot,
            relativePath: resolved.relativePath,
            expiresAt,
          }
        : {
            version: 1,
            kind: "workspace-file",
            workspaceRoot: canonicalWorkspaceRoot,
            baseRelativePath: path.dirname(resolved.relativePath),
            expiresAt,
          };
      fileName = path.basename(resolved.relativePath);
      break;
    }
    case "attachment": {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        expiresAt,
      };
      fileName = path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.resource.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
      const faviconPath = yield* faviconResolver.resolvePath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetProjectFaviconResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = faviconPath ? path.relative(workspaceRoot, faviconPath) : null;
      if (
        relativePath &&
        !(yield* resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath }).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        ))
      ) {
        return yield* new AssetProjectFaviconNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "project-favicon",
        workspaceRoot: yield* fileSystem.realPath(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceResolutionError({
                resource: input.resource,
                cause,
              }),
          ),
        ),
        relativePath,
        expiresAt,
      };
      fileName = relativePath ? path.basename(relativePath) : "favicon.svg";
      break;
    }
  }

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.mapError(
      (cause) =>
        new AssetSigningKeyLoadError({
          resource: input.resource,
          cause,
        }),
    ),
  );
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
  };
});

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) return null;

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig.ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* optionOnNotFound(fileSystem.stat(attachmentPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({ kind: "file", path: attachmentPath } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) {
      return {
        kind: "project-favicon-fallback",
        svg: yield* resolveProjectFaviconFallbackSvg(claims.workspaceRoot),
      } satisfies ResolvedAsset;
    }
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? ({ kind: "file", path: faviconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;
  if (claims.kind === "workspace-file-exact") {
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    const exactWorkspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return exactWorkspaceFile
      ? ({ kind: "file", path: exactWorkspaceFile } satisfies ResolvedAsset)
      : null;
  }
  const segments = decodedPath.split(/[\\/]/);
  if (
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    !PREVIEW_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
  ) {
    return null;
  }
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const workspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
    workspaceRoot: claims.workspaceRoot,
    relativePath: joinedRelativePath,
  });
  return workspaceFile ? ({ kind: "file", path: workspaceFile } satisfies ResolvedAsset) : null;
});
