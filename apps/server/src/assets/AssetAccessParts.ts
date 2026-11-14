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
import type { AssetClaims } from "./AssetAccess.ts";
import { ASSET_ROUTE_PREFIX, ASSET_TOKEN_TTL_MS, HTML_ATTACHMENT_TOKEN_BUCKET_MS, INLINE_VIDEO_MIME_TYPE_PATTERN, PROJECT_FAVICON_TOKEN_BUCKET_MS, PROJECT_FAVICON_VERSION_PREFIX, SIGNING_SECRET_NAME, encodeAssetClaims, finalizeAbsoluteMediaFileAsset, finalizeWorkspaceFileAsset, inlinePreviewMimeTypeForExtension, readImageDimensionsFromHeader, readToolOutputImage, resolveCanonicalFile, resolveCanonicalWorkspaceFile } from "./AssetAccess.ts";

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
  readonly projectFaviconPath?: string;
  /** Where a cloned project's checkout stands, while the clone tracker still knows it. */
  readonly projectCheckout?: "pending" | "cloned";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  let expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;
  let sourcePath: string | undefined;
  let imageDimensions: ImageDimensions | null = null;
  let fileRevision: string | undefined;

  switch (input.resource._tag) {
    case "media-file": {
      let requestedPath = expandHomePath(input.resource.path, yield* HostProcess.HomeDirectory);
      if (!path.isAbsolute(requestedPath)) {
        if (!input.workspaceRoot) {
          return yield* new AssetWorkspaceContextNotFoundError({ resource: input.resource });
        }
        const workspaceRoot = yield* workspacePaths
          .normalizeWorkspaceRoot(input.workspaceRoot)
          .pipe(
            Effect.mapError(
              (cause) =>
                new AssetWorkspaceRootNormalizationError({ resource: input.resource, cause }),
            ),
          );
        requestedPath = path.resolve(workspaceRoot, requestedPath);
      }
      const finalized = yield* finalizeAbsoluteMediaFileAsset({
        requestedPath,
        workspaceRoot: input.workspaceRoot,
        resource: input.resource,
        expiresAt,
      });
      claims = finalized.claims;
      fileName = finalized.fileName;
      imageDimensions = finalized.imageDimensions;
      fileRevision = finalized.fileRevision;
      break;
    }
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
      const finalized = yield* finalizeWorkspaceFileAsset({
        workspaceRoot,
        requestedPath: input.resource.path,
        resource: input.resource,
        expiresAt,
      });
      claims = finalized.claims;
      fileName = finalized.fileName;
      imageDimensions = finalized.imageDimensions;
      break;
    }
    case "draft-workspace-file": {
      const draftWorkspaceRoot = input.workspaceRoot ?? input.resource.cwd;
      const hostPath = input.resource.path.startsWith("~/")
        ? expandHomePath(input.resource.path, yield* HostProcess.HomeDirectory)
        : input.resource.path;
      if (path.isAbsolute(hostPath)) {
        const finalized = yield* finalizeAbsoluteMediaFileAsset({
          requestedPath: hostPath,
          workspaceRoot: draftWorkspaceRoot,
          resource: input.resource,
          expiresAt,
        });
        claims = finalized.claims;
        fileName = finalized.fileName;
        imageDimensions = finalized.imageDimensions;
        fileRevision = finalized.fileRevision;
        break;
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(draftWorkspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const finalized = yield* finalizeWorkspaceFileAsset({
        workspaceRoot,
        requestedPath: input.resource.path,
        resource: input.resource,
        expiresAt,
      });
      claims = finalized.claims;
      fileName = finalized.fileName;
      imageDimensions = finalized.imageDimensions;
      fileRevision = finalized.fileRevision;
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
      const extension = parseAttachmentFileExtension(input.resource.attachmentId);
      const isGenericFile = extension !== null;
      const videoMimeType = input.resource.mimeType?.split(";", 1)[0]?.trim() ?? "";
      const isVideo = INLINE_VIDEO_MIME_TYPE_PATTERN.test(videoMimeType);
      const inlinePreviewMimeType =
        input.resource.disposition === "inline" && extension !== null
          ? inlinePreviewMimeTypeForExtension(extension)
          : undefined;
      if (!isGenericFile) {
        imageDimensions = yield* fileSystem.realPath(attachmentPath).pipe(
          Effect.flatMap(readImageDimensionsFromHeader),
          Effect.orElseSucceed(() => null),
        );
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        ...(isGenericFile && !isVideo && inlinePreviewMimeType === undefined
          ? { download: true }
          : {}),
        ...(input.resource.fileName !== undefined ? { fileName: input.resource.fileName } : {}),
        ...(inlinePreviewMimeType !== undefined
          ? { mimeType: inlinePreviewMimeType }
          : input.resource.mimeType !== undefined
            ? { mimeType: isVideo ? videoMimeType : input.resource.mimeType }
            : {}),
        ...(input.resource.renderIntent === "mcp-app" && inlinePreviewMimeType === "text/html"
          ? { renderIntent: "mcp-app" as const }
          : {}),
        expiresAt,
      };
      fileName = input.resource.fileName ?? path.basename(attachmentPath);
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
      // A lookup in a half-cloned checkout would cache a miss that outlives the clone.
      // Once it lands, a miss cached before (by enrichment) is stale too.
      if (input.projectCheckout === "cloned") yield* faviconResolver.invalidate(workspaceRoot);
      const faviconPath =
        input.projectCheckout === "pending"
          ? null
          : yield* faviconResolver
              .resolvePath(workspaceRoot, input.projectFaviconPath ?? undefined)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetProjectFaviconResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
      const isExternalOverride =
        faviconPath !== null &&
        input.projectFaviconPath !== undefined &&
        path.isAbsolute(input.projectFaviconPath) &&
        path.normalize(faviconPath) === path.normalize(input.projectFaviconPath);
      const relativePath =
        faviconPath && !isExternalOverride ? path.relative(workspaceRoot, faviconPath) : null;
      const sourceFaviconPath = isExternalOverride ? faviconPath : relativePath;
      if (sourceFaviconPath && !isProjectFaviconPath(sourceFaviconPath)) {
        return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
      }
      sourcePath = sourceFaviconPath ?? undefined;
      const canonicalFaviconPath = sourceFaviconPath
        ? yield* (
            isExternalOverride
              ? resolveCanonicalFile(sourceFaviconPath)
              : resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath: sourceFaviconPath })
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AssetProjectFaviconInspectionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          )
        : null;
      if (sourceFaviconPath && !canonicalFaviconPath) {
        return yield* new AssetProjectFaviconNotFoundError({
          resource: input.resource,
        });
      }
      claims =
        isExternalOverride && canonicalFaviconPath
          ? {
              version: 1,
              kind: "project-favicon-external",
              filePath: canonicalFaviconPath,
              expiresAt,
            }
          : {
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
      if (sourceFaviconPath && canonicalFaviconPath) {
        const digest = yield* Digest.Digest;
        const faviconBytes = yield* fileSystem.readFile(canonicalFaviconPath).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        const revision = yield* digest.digest(Digest.sha256, faviconBytes).pipe(
          Effect.map(Hex.encode),
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        fileName = `${PROJECT_FAVICON_VERSION_PREFIX}${revision}-${path.basename(sourceFaviconPath)}`;
      } else {
        fileName = PROJECT_FAVICON_FALLBACK_MARKER;
      }
      break;
    }
    case "tool-output-image": {
      const image = yield* readToolOutputImage(input.resource).pipe(
        Effect.mapError(
          (cause) => new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
        ),
      );
      if (image === null) {
        return yield* new AssetWorkspaceAssetNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "tool-output-image",
        threadId: input.resource.threadId,
        itemId: input.resource.itemId,
        index: input.resource.index,
        expiresAt,
      };
      fileName = `image-${input.resource.index + 1}.${image.mimeType.slice("image/".length)}`;
      imageDimensions = readImageDimensions(image.bytes);
      break;
    }
    case "native-app-icon": {
      claims = {
        version: 1,
        kind: "native-app-icon",
        app: input.resource.app,
        expiresAt,
      };
      fileName = "native-app-icon.png";
      break;
    }
    case SOURCE_CONTROL_MEDIA_ASSET: {
      const media = sourceControlDefinitions.mediaUrl(input.resource.url);
      if (media === null) {
        return yield* new AssetSourceControlMediaUrlValidationError({});
      }
      claims = {
        version: 1,
        kind: SOURCE_CONTROL_MEDIA_ASSET,
        url: media.fetchUrl,
        cwd: input.resource.cwd,
        expiresAt,
      };
      fileName = media.fileName;
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
  if (claims.kind === "project-favicon" || claims.kind === "project-favicon-external") {
    const issuedAt = yield* Clock.currentTimeMillis;
    expiresAt =
      (Math.floor(issuedAt / PROJECT_FAVICON_TOKEN_BUCKET_MS) + 2) *
      PROJECT_FAVICON_TOKEN_BUCKET_MS;
    claims = { ...claims, expiresAt };
  }
  if (claims.kind === "attachment" && claims.mimeType === "text/html") {
    // Stable URLs let immutable HTML reloads hit the cache; image retries need fresh URLs.
    expiresAt =
      Math.ceil(expiresAt / HTML_ATTACHMENT_TOKEN_BUCKET_MS) * HTML_ATTACHMENT_TOKEN_BUCKET_MS;
    claims = { ...claims, expiresAt };
  }
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(imageDimensions !== null ? { imageDimensions } : {}),
    ...(fileRevision !== undefined ? { fileRevision } : {}),
  };
});

