import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { ImageSource } from "expo-image";

/**
 * Signed URLs change on each mint and reconnect, so a URL-keyed cache misses every time.
 * Content that cannot change caches under its identity, and host files under the revision the
 * server read. Anything else stays keyed by URL.
 */
export function assetImageCacheKey(
  environmentId: EnvironmentId,
  resource: AssetResource,
  fileRevision?: string,
): string | undefined {
  switch (resource._tag) {
    case "attachment":
      return `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`;
    case SOURCE_CONTROL_MEDIA_ASSET: {
      const media = sourceControlClients.mediaUrl(resource.url);
      return media?.immutable
        ? `t3-media:${JSON.stringify([environmentId, media.fetchUrl])}`
        : undefined;
    }
    case "media-file":
    case "workspace-file":
    case "draft-workspace-file":
      return fileRevision === undefined
        ? undefined
        : `t3-file:${JSON.stringify([
            environmentId,
            resource._tag === "draft-workspace-file" ? resource.cwd : resource.threadId,
            resource.path,
            fileRevision,
          ])}`;
    // A tool can replace the image at its index, and nothing cheap identifies its bytes.
    default:
      return undefined;
  }
}

export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
  fileRevision?: string,
): ImageSource {
  const cacheKey = assetImageCacheKey(environmentId, resource, fileRevision);
  return cacheKey === undefined ? { uri } : { uri, cacheKey };
}
