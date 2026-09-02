import type { ComposerFileAttachment } from "../../composerDraftStore";
import { type ChatImageAttachment, isVideoAttachment } from "../../types";
import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaFileReference, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import type { MediaActionSource } from "../media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export interface ExpandedImageItem {
  src: string;
  name: string;
  type?: "video";
  autoPlay?: boolean;
  /** Authored remote destination to open when embedding fails, never a generated asset URL. */
  originalUrl?: string;
  actionsSource?: MediaActionSource;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

/** Resolves a chat media reference on its owning environment, without downloading its bytes. */
export async function resolveMarkdownMediaPreview(input: {
  source: string;
  resolvedFilePath?: string | undefined;
  cwd?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  httpBaseUrl?: string | undefined;
  onOpenFile?: ((relativePath: string) => void) | undefined;
  createAssetUrl: (input: {
    environmentId: EnvironmentId;
    input: { resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
}): Promise<ExpandedImagePreview | null> {
  const source =
    input.resolvedFilePath === undefined
      ? classifyMarkdownImageSource(input.source, input.cwd)
      : { _tag: "WorkspaceFile" as const, path: input.resolvedFilePath };
  if (source._tag === "Blocked") return null;

  const path =
    source._tag === "Direct"
      ? source.uri.split(/[?#]/, 1)[0]!
      : source.path.replace(/:\d+(?::\d+)?$/, "");
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = name.lastIndexOf(".");
  const fileMimeType =
    extensionIndex < 0 ? null : mediaMimeTypeFromExtension(name.slice(extensionIndex));
  const kind =
    source._tag === "Direct"
      ? mediaKindFromPath(source.uri)
      : fileMimeType === null
        ? null
        : fileMimeType.startsWith("video/")
          ? "video"
          : "image";
  if (kind === null) return null;

  const reference =
    source._tag === "Direct" ? mediaUrlReference(source.uri) : mediaFileReference(path, input.cwd);
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  let src: string;
  let asset: MediaActionSource["asset"];
  if (source._tag === "Direct") {
    src = resolveProtocolRelativeMediaUrl(source.uri);
  } else {
    if (!input.threadRef || !input.httpBaseUrl) {
      throw new Error("Reconnect to this environment and open the media again.");
    }
    asset = {
      environmentId: input.threadRef.environmentId,
      resource: { _tag: "media-file", threadId: input.threadRef.threadId, path },
    };
    const result = await input.createAssetUrl({
      environmentId: asset.environmentId,
      input: { resource: asset.resource },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const assetUrl = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
    if (assetUrl === null) throw new Error("The environment returned an invalid media URL.");
    src = assetUrl + markdownImageSourceFragment(input.source);
  }
  return {
    images: [
      {
        src,
        name: name || kind,
        ...(kind === "video" ? { type: "video", autoPlay: false } : {}),
        ...(source._tag === "Direct" && resolveExternalWebLinkHost(source.uri) !== null
          ? { originalUrl: source.uri }
          : {}),
        actionsSource: {
          kind,
          name: name || kind,
          src,
          ...(reference ? { reference } : {}),
          ...(asset ? { asset } : {}),
          ...(relativePath && input.onOpenFile
            ? { onOpenFile: () => input.onOpenFile?.(relativePath) }
            : {}),
        },
      },
    ],
    index: 0,
  };
}

export function attachVideoThumbnail(video: HTMLVideoElement, file: File): () => void {
  const url = URL.createObjectURL(file);
  video.src = url;
  return () => URL.revokeObjectURL(url);
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<ChatImageAttachment | ComposerFileAttachment>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const selected = images.find((image) => image.id === selectedImageId);
  if (selected?.type === "file" && selected.file && isVideoAttachment(selected)) {
    return {
      images: [{ src: URL.createObjectURL(selected.file), name: selected.name, type: "video" }],
      index: 0,
    };
  }
  const previewableImages = images.flatMap((image) =>
    image.type === "image" && image.previewUrl
      ? [{ id: image.id, src: image.previewUrl, name: image.name }]
      : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}
