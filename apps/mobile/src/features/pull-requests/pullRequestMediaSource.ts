import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import type { EnvironmentId } from "@t3tools/contracts";
import { pullRequestMediaResource } from "@t3tools/shared/pullRequestMedia";
import type { FilePreviewItem } from "../../components/FilePreviewModal.types";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/** Keep the original resource identity so previewers can resolve and renew its capability. */
export function pullRequestMediaSource(url: string, location: PullRequestMediaLocation | null) {
  const resource = location ? pullRequestMediaResource(url, location.cwd) : null;
  return location && resource
    ? {
        environmentId: location.environmentId,
        resource,
        ...(resource._tag === "bitbucket-media"
          ? { fallbackUri: url, srcFragment: markdownImageSourceFragment(url) }
          : {}),
      }
    : { uri: url };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location) };
}
