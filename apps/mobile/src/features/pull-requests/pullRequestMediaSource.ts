import type { PullRequestBodySegment } from "@t3tools/client-runtime/pull-request-markdown";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET, type EnvironmentId } from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { videoMimeType } from "@t3tools/shared/video";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";
import { filePreviewKey, imagePreviewName } from "../../lib/filePreviewGallery";
import { markdownImages } from "../../lib/markdownImageSources";

export function isPullRequestWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function pullRequestVideoMimeType(url: string): string | null {
  return videoMimeType({ name: url.split(/[?#]/)[0] ?? url, mimeType: "" });
}

export function isPullRequestVideoUrl(url: string): boolean {
  return pullRequestVideoMimeType(url) !== null;
}

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

export function pullRequestImageMimeType(url: string): string {
  const path = url.split(/[?#]/)[0] ?? url;
  const basename = path.split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  const mime = dot > 0 ? mediaMimeTypeFromExtension(basename.slice(dot)) : null;
  return mime?.startsWith("image/") ? mime : "image/*";
}

export function pullRequestImageSource(
  url: string,
  location: PullRequestMediaLocation | null,
  name?: string,
): FilePreviewItem {
  const media = pullRequestMediaSource(url, location);
  const mimeType = pullRequestImageMimeType(url);
  const resolvedName = name ?? pullRequestImageName(url, null, "Image");
  return {
    kind: "image",
    ...media,
    ...(name !== undefined ? { name } : {}),
    mimeType,
    ...(isPullRequestWebUrl(url)
      ? { actionsSource: { ...media, name: resolvedName, mimeType } }
      : {}),
  };
}

export function pullRequestImageName(
  url: string,
  label: string | null | undefined,
  fallback: string,
): string {
  return imagePreviewName(url, label, fallback);
}

/** Scopes zoom targets per gallery surface so strips, descriptions, and comments never collide. */
export function pullRequestScopedSourceIdentifier(scope: string, source: FilePreviewItem): string {
  return `${scope}:${filePreviewKey(source)}`;
}

export function pullRequestMarkdownImages(
  segments: readonly PullRequestBodySegment[],
  resolveUrl: (href: string) => string = (href) => href,
): { readonly uri: string; readonly alt: string | null }[] {
  const images = new Map<string, string | null>();
  const add = (href: string, alt: string | null) => {
    const uri = resolveUrl(href);
    if (!isPullRequestWebUrl(uri) || isPullRequestVideoUrl(uri)) return;
    const existing = images.get(uri);
    if (existing === undefined || (existing === null && alt !== null)) {
      images.set(uri, alt);
    }
  };
  const visit = (segment: PullRequestBodySegment) => {
    if (segment.kind === "markdown") {
      for (const image of markdownImages(segment.text)) add(image.url, image.alt);
      return;
    }
    if (segment.kind === "attachment") {
      if (segment.media === "image") add(segment.url, null);
      return;
    }
    for (const row of segment.rows) {
      for (const cell of row) {
        for (const inner of cell.segments) visit(inner);
      }
    }
  };
  for (const segment of segments) visit(segment);
  return [...images.entries()].map(([uri, alt]) => ({ uri, alt }));
}
