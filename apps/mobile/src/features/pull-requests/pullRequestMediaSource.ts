import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly repository?: string;
}

/** Keep the original resource identity so previewers can resolve and renew its capability. */
export function pullRequestMediaSource(url: string, location: PullRequestMediaLocation | null) {
  const fetchUrl = sourceControlClients.mediaUrl(url)?.fetchUrl;
  return location && fetchUrl
    ? {
        environmentId: location.environmentId,
        resource: {
          _tag: SOURCE_CONTROL_MEDIA_ASSET,
          cwd: location.cwd,
          url: fetchUrl,
          ...(location.repository ? { repository: location.repository } : {}),
        },
      }
    : { uri: url };
}

/**
 * The request for an image the markdown renderer loads itself. Host media needs the environment's
 * credentials, so it fails rather than load unauthorized; null loads any other image as written.
 */
export async function pullRequestImageRequest(
  url: string,
  location: PullRequestMediaLocation | null,
  authorize: (environmentId: EnvironmentId, resource: AssetResource) => Promise<string | null>,
): Promise<{ readonly uri: string } | null> {
  const source = pullRequestMediaSource(url, location);
  const resource = "resource" in source ? source.resource : undefined;
  if (location === null || resource === undefined) return null;
  const uri = await authorize(location.environmentId, resource);
  if (uri === null) throw new Error("Could not authorize pull request image");
  return { uri };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location) };
}
