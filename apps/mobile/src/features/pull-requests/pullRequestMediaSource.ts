import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveChangeRequestMediaUrl,
  pullRequestMediaResource,
} from "@t3tools/client-runtime/pull-request-markdown";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";

import { normalizeNativeMarkdownUrl } from "../../lib/markdownLinks";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { videoMimeType } from "@t3tools/shared/video";

export interface PullRequestMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly repository?: string;
}

/** Keep the original resource identity so previewers can resolve and renew its capability. */
export function pullRequestMediaSource(url: string, location: PullRequestMediaLocation | null) {
  const resource = location
    ? pullRequestMediaResource(url, location.cwd, location.repository)
    : null;
  return location && resource
    ? {
        environmentId: location.environmentId,
        resource,
      }
    : { uri: url };
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
): FilePreviewItem {
  return { kind: "image", ...pullRequestMediaSource(url, location) };
}

export function pullRequestImageGallery(
  markdown: string,
  location: PullRequestMediaLocation | null,
  changeRequestUrl: string | null,
): FilePreviewItem[] {
  return markdownImageSources(markdown)
    .map((href) =>
      normalizeNativeMarkdownUrl(
        changeRequestUrl ? resolveChangeRequestMediaUrl(href, changeRequestUrl) : href,
      ),
    )
    .filter(
      (uri) =>
        /^https?:\/\//i.test(uri) &&
        videoMimeType({ name: uri.split(/[?#]/)[0] ?? uri, mimeType: "" }) === null,
    )
    .map((uri) => pullRequestImageSource(uri, location));
}
