import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { immutableGithubMediaUrl } from "@t3tools/shared/githubMedia";
import type { ImageSource } from "expo-image";

/**
 * Every mint signs a new URL, so a URL-keyed cache misses each time. Content
 * that cannot change caches under its identity instead, and files under their
 * identity plus the version the server read from disk. Anything else stays
 * keyed by URL, as does GitHub media from servers that send no `accessScope`.
 */
export function assetImageCacheKey(
  environmentId: EnvironmentId,
  resource: AssetResource,
  version?: { readonly fileRevision?: string; readonly accessScope?: string },
): string | undefined {
  switch (resource._tag) {
    case "attachment":
      return `t3-attachment:${JSON.stringify(
        version?.fileRevision === undefined
          ? [environmentId, resource.attachmentId]
          : [environmentId, resource.attachmentId, version.fileRevision],
      )}`;
    case "github-media": {
      const url = immutableGithubMediaUrl(resource.url);
      return url === null || version?.accessScope === undefined
        ? undefined
        : `t3-github-media:${JSON.stringify([environmentId, version.accessScope, url])}`;
    }
    case "workspace-file":
    case "media-file":
    case "draft-workspace-file":
      return version?.fileRevision === undefined
        ? undefined
        : `t3-file:${JSON.stringify([
            environmentId,
            resource._tag,
            resource._tag === "draft-workspace-file" ? resource.cwd : resource.threadId,
            resource.path,
            version.fileRevision,
          ])}`;
    // A tool can replace the image at an index, and nothing cheap identifies its bytes.
    case "tool-output-image":
    case "project-favicon":
    case "native-app-icon":
      return undefined;
  }
}

export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  asset: { readonly url: string; readonly fileRevision?: string; readonly accessScope?: string },
): ImageSource {
  const cacheKey = assetImageCacheKey(environmentId, resource, asset);
  return cacheKey === undefined ? { uri: asset.url } : { uri: asset.url, cacheKey };
}
