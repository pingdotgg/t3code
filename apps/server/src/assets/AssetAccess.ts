import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetSourceControlMediaUrlValidationError,
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
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  ToolActivityNativeAppReference,
  TurnItemId,
} from "@t3tools/contracts";
import {
  hostPreviewMimeTypeFromExtension,
  isWorkspaceAudioPreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
  type ImageDimensions,
} from "@t3tools/shared/imageDimensions";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import {
  isProjectFaviconPath,
  PROJECT_FAVICON_FALLBACK_MARKER,
} from "@t3tools/shared/projectFavicon";
import { isNetworkPath } from "@t3tools/shared/path";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH, toolOutputImages } from "@t3tools/shared/toolOutput";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { extractIcnsPng } from "./icns.ts";
import { openMediaFile, readMediaFileHeader, type OpenMediaFile } from "./MediaFile.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const ASSET_ROUTE_PREFIX = "/api/assets";

export const SIGNING_SECRET_NAME = "asset-access-signing-key";
export const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const PROJECT_FAVICON_TOKEN_BUCKET_MS = 30 * 60 * 1000;
export const HTML_ATTACHMENT_TOKEN_BUCKET_MS = 30 * 60 * 1000;
export const PROJECT_FAVICON_VERSION_PREFIX = "v";
const PROJECT_FAVICON_ICNS_MIN_SIZE = 96;
export const INLINE_VIDEO_MIME_TYPE_PATTERN = /^video\/[\w!#$&^.+-]+$/i;
// Use server-assigned attachment extensions, never client MIME types.
const INLINE_PREVIEW_MIME_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
};
export const inlinePreviewMimeTypeForExtension = (extension: string) =>
  INLINE_PREVIEW_MIME_TYPES[extension] ??
  hostPreviewMimeTypeFromExtension(`.${extension}`) ??
  undefined;
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  // Keep HTML dependency grants independent of newly supported file viewers.
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

export const AssetClaimsSchema = Schema.Union([
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
    kind: Schema.Literal("media-file-exact"),
    filePath: Schema.String,
    download: Schema.optionalKey(Schema.Boolean),
    device: Schema.String,
    inode: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    download: Schema.optionalKey(Schema.Boolean),
    fileName: Schema.optionalKey(Schema.String),
    mimeType: Schema.optionalKey(Schema.String),
    renderIntent: Schema.optionalKey(Schema.Literal("mcp-app")),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon-external"),
    filePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("native-app-icon"),
    app: ToolActivityNativeAppReference,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("tool-output-image"),
    threadId: ThreadId,
    itemId: TurnItemId,
    index: Schema.Number,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal(SOURCE_CONTROL_MEDIA_ASSET),
    /** A host's `fetchUrl`, narrowed at mint time; the signature is what keeps it there. */
    url: Schema.String,
    cwd: Schema.String,
    expiresAt: Schema.Number,
  }),
]);
export type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
export const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly download?: boolean;
      readonly fileName?: string;
      readonly mimeType?: string;
      readonly file?: OpenMediaFile;
      readonly renderIntent?: "mcp-app";
    }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mimeType: string;
    }
  | {
      readonly kind: "source-control-media";
      readonly url: string;
      readonly cwd: string;
      readonly expiresAt: number;
    };

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

export const readMcpAppHtml = Effect.fn("AssetAccess.readMcpAppHtml")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Allow space for stored CSP tags, but bound reads if the attachment grows after minting.
  const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
  const chunks = yield* Stream.runCollect(fileSystem.stream(filePath, { bytesToRead: limit + 1 }));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (size > limit) return null;
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
});

export const readToolOutputImage = Effect.fn("AssetAccess.readToolOutputImage")(function* (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly index: number;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const item = yield* orchestrator.getTurnItem(input);
  const image =
    item?.type === "dynamic_tool" ? toolOutputImages(item.output)[input.index] : undefined;
  return image?.data === undefined || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH
    ? null
    : { mimeType: image.mimeType, bytes: Buffer.from(image.data, "base64") };
});

// Browsers cannot draw .icns; serve its embedded PNG.
const projectFaviconAsset = Effect.fn("AssetAccess.projectFaviconAsset")(function* (
  filePath: string,
) {
  if (!filePath.toLowerCase().endsWith(".icns")) {
    return { kind: "file", path: filePath } satisfies ResolvedAsset;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* fileSystem.readFile(filePath).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to read project icon image.", { filePath, cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  const png = bytes ? extractIcnsPng(bytes, PROJECT_FAVICON_ICNS_MIN_SIZE) : null;
  return png
    ? ({ kind: "bytes", bytes: png, mimeType: "image/png" } satisfies ResolvedAsset)
    : null;
});

export const resolveCanonicalFile = Effect.fn("AssetAccess.resolveCanonicalFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const canonicalFile = yield* ProjectFaviconResolver.optionOnNotFound(
    fileSystem.realPath(filePath),
  );
  if (Option.isNone(canonicalFile)) return null;

  const info = yield* ProjectFaviconResolver.optionOnNotFound(fileSystem.stat(canonicalFile.value));
  if (Option.isNone(info) || info.value.type !== "File") return null;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  return (yield* isServerInternalPath(canonicalFile.value)) ? null : canonicalFile.value;
});

export const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.asSome,
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeedNone,
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      ProjectFaviconResolver.optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      ProjectFaviconResolver.optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* ProjectFaviconResolver.optionOnNotFound(
      fileSystem.stat(canonicalFile.value),
    );
    if (Option.isNone(info) || info.value.type !== "File") return null;
    const isServerInternalPath = yield* makeIsServerInternalPath;
    return (yield* isServerInternalPath(canonicalFile.value)) ? null : canonicalFile.value;
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

const HEADER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const readImageDimensionsFromOpenFile = (filePath: string, file: OpenMediaFile) =>
  readMediaFileHeader(filePath, file, IMAGE_DIMENSIONS_HEADER_BYTES).pipe(
    Effect.map(readImageDimensions),
    Effect.orElseSucceed((): ImageDimensions | null => null),
  );

// Non-blocking open prevents swapped-in FIFOs from hanging the request.
export const readImageDimensionsFromHeader = (filePath: string) =>
  openMediaFile(filePath).pipe(
    Effect.flatMap((file) =>
      file === null ? Effect.succeed(null) : readImageDimensionsFromOpenFile(filePath, file),
    ),
    Effect.scoped,
    Effect.orElseSucceed((): ImageDimensions | null => null),
  );

export const finalizeAbsoluteMediaFileAsset = Effect.fn("AssetAccess.finalizeAbsoluteMediaFileAsset")(
  function* (input: {
    readonly requestedPath: string;
    readonly expectedCanonicalPath?: string;
    readonly workspaceRoot: string | undefined;
    readonly resource: AssetResource;
    readonly expiresAt: number;
  }) {
    const path = yield* Path.Path;
    // Resolving a network path makes Windows sign in to its host with the
    // user's NTLM credentials, so only the thread's own project may be on a share.
    // Windows reads a `\\?\` path as written, `..` included, so the lookup gets
    // the resolved path this check approved.
    const requestedPath = path.resolve(input.requestedPath);
    if (
      isNetworkPath(input.requestedPath) &&
      (input.workspaceRoot === undefined ||
        !isWithinRoot(path, requestedPath, path.resolve(input.workspaceRoot)))
    ) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
        checkedPath: input.requestedPath,
      });
    }
    const canonicalFile = yield* resolveCanonicalFile(requestedPath).pipe(
      Effect.mapError(
        (cause) => new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
      ),
    );
    // The workspace caller pins its containment-checked path; never follow a
    // replacement symlink to a different file during this second resolution.
    if (
      !canonicalFile ||
      (input.expectedCanonicalPath !== undefined && canonicalFile !== input.expectedCanonicalPath)
    ) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
        checkedPath: input.requestedPath,
      });
    }
    const download =
      input.resource._tag === "media-file" && input.resource.disposition === "attachment";
    if (!download && hostPreviewMimeTypeFromExtension(path.extname(canonicalFile)) === null) {
      return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
    }
    const wantsDimensions = HEADER_IMAGE_EXTENSIONS.has(path.extname(canonicalFile).toLowerCase());
    const opened = yield* openMediaFile(canonicalFile).pipe(
      Effect.flatMap((file) =>
        file === null
          ? Effect.succeed(null)
          : Effect.map(
              wantsDimensions
                ? readImageDimensionsFromOpenFile(canonicalFile, file)
                : Effect.succeed(null),
              (dimensions) => ({
                identity: { device: file.info.dev.toString(), inode: file.info.ino.toString() },
                fileRevision: `${file.info.dev}:${file.info.ino}:${file.info.size}:${file.info.mtimeNs}:${file.info.ctimeNs}`,
                dimensions,
              }),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (cause) => new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
      ),
    );
    if (!opened) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
        checkedPath: input.requestedPath,
      });
    }
    return {
      claims: {
        version: 1 as const,
        kind: "media-file-exact" as const,
        filePath: canonicalFile,
        ...(download ? { download: true } : {}),
        ...opened.identity,
        expiresAt: input.expiresAt,
      },
      fileName: path.basename(canonicalFile),
      fileRevision: opened.fileRevision,
      imageDimensions: opened.dimensions,
    };
  },
);

export const finalizeWorkspaceFileAsset = Effect.fn("AssetAccess.finalizeWorkspaceFileAsset")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly requestedPath: string;
    readonly resource: AssetResource;
    readonly expiresAt: number;
  }) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const relativePath = path.isAbsolute(input.requestedPath)
      ? path.relative(input.workspaceRoot, input.requestedPath)
      : input.requestedPath;
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: input.workspaceRoot, relativePath })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspacePathValidationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
    const isDraftMedia =
      input.resource._tag === "draft-workspace-file" &&
      (isWorkspaceAudioPreviewPath(resolved.relativePath) ||
        isWorkspaceVideoPreviewPath(resolved.relativePath));
    if (!isDraftMedia && !isWorkspacePreviewEntryPath(resolved.relativePath)) {
      return yield* new AssetPreviewTypeValidationError({
        resource: input.resource,
      });
    }
    const canonicalFile = yield* resolveCanonicalWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
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
    if (isDraftMedia) {
      return yield* finalizeAbsoluteMediaFileAsset({
        ...input,
        requestedPath: canonicalFile,
        expectedCanonicalPath: canonicalFile,
      });
    }
    const canonicalWorkspaceRoot = yield* fileSystem.realPath(input.workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new AssetWorkspaceResolutionError({
            resource: input.resource,
            cause,
          }),
      ),
    );
    const imageDimensions = HEADER_IMAGE_EXTENSIONS.has(
      path.extname(resolved.relativePath).toLowerCase(),
    )
      ? yield* readImageDimensionsFromHeader(canonicalFile)
      : null;
    return {
      claims: !/\.html?$/i.test(resolved.relativePath)
        ? {
            version: 1 as const,
            kind: "workspace-file-exact" as const,
            workspaceRoot: canonicalWorkspaceRoot,
            relativePath: resolved.relativePath,
            expiresAt: input.expiresAt,
          }
        : {
            version: 1 as const,
            kind: "workspace-file" as const,
            workspaceRoot: canonicalWorkspaceRoot,
            baseRelativePath: path.dirname(resolved.relativePath),
            expiresAt: input.expiresAt,
          },
      fileName: path.basename(resolved.relativePath),
      imageDimensions,
      fileRevision: undefined,
    };
  },
);

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
    const info = yield* ProjectFaviconResolver.optionOnNotFound(
      fileSystem.stat(attachmentPath),
    ).pipe(
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
      ? ({
          kind: "file",
          path: attachmentPath,
          ...(claims.download ? { download: true } : {}),
          ...(claims.fileName !== undefined ? { fileName: claims.fileName } : {}),
          ...(claims.mimeType !== undefined ? { mimeType: claims.mimeType } : {}),
          ...(claims.renderIntent === "mcp-app" ? { renderIntent: "mcp-app" as const } : {}),
        } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) return null;
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? yield* projectFaviconAsset(faviconPath) : null;
  }

  if (claims.kind === "project-favicon-external") {
    const faviconPath = yield* resolveCanonicalFile(claims.filePath).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to resolve canonical asset path.", {
          filePath: claims.filePath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return faviconPath === claims.filePath ? yield* projectFaviconAsset(faviconPath) : null;
  }

  if (claims.kind === SOURCE_CONTROL_MEDIA_ASSET) {
    return {
      kind: "source-control-media",
      url: claims.url,
      cwd: claims.cwd,
      expiresAt: claims.expiresAt,
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "tool-output-image") {
    const image = yield* readToolOutputImage(claims).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to read tool output image.", {
          threadId: claims.threadId,
          itemId: claims.itemId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return image ? ({ kind: "bytes", ...image } satisfies ResolvedAsset) : null;
  }

  if (claims.kind === "native-app-icon") {
    const nativeAppIconResolver = yield* NativeAppIconResolver.NativeAppIconResolver;
    const iconPath = yield* nativeAppIconResolver.resolve(claims.app);
    return iconPath ? ({ kind: "file", path: iconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;
  if (claims.kind === "media-file-exact") {
    if (decodedPath !== path.basename(claims.filePath)) return null;
    const canonicalFile = yield* resolveCanonicalFile(claims.filePath).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to resolve canonical media path.", {
          filePath: claims.filePath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (canonicalFile !== claims.filePath) return null;
    const mimeType = claims.download
      ? "application/octet-stream"
      : hostPreviewMimeTypeFromExtension(path.extname(canonicalFile));
    if (!mimeType) return null;
    const file = yield* openMediaFile(canonicalFile, claims).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to open canonical media file.", { filePath: canonicalFile, cause }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return file
      ? ({
          kind: "file",
          path: canonicalFile,
          mimeType,
          file,
          ...(claims.download ? { download: true, fileName: path.basename(canonicalFile) } : {}),
        } satisfies ResolvedAsset)
      : null;
  }
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
export * from "./AssetAccessParts.ts";
