import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET, type EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly repository?: string;
  /** The change request's host, for a GitHub Enterprise Server the URL alone does not name. */
  readonly host?: string | undefined;
}

/** Keep the original resource identity so previewers can resolve and renew its capability. */
export function pullRequestMediaSource(url: string, location: PullRequestMediaLocation | null) {
  const fetchUrl = sourceControlClients.mediaUrl(url, location?.host)?.fetchUrl;
  return location && fetchUrl
    ? {
        environmentId: location.environmentId,
        resource: {
          _tag: SOURCE_CONTROL_MEDIA_ASSET,
          cwd: location.cwd,
          url: fetchUrl,
          ...(location.repository ? { repository: location.repository } : {}),
          ...(location.host ? { host: location.host } : {}),
        },
      }
    : { uri: url };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location) };
}
