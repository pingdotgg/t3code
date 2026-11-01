import { videoMimeType } from "./video.ts";

const ICON_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/vnd.sqlite3": "sqlite",
  "text/x-python": "py",
  "text/javascript": "js",
  "text/x-ruby": "rb",
  "text/x-shellscript": "sh",
};

export function fileIconPathForMimeType(path: string, mimeType?: string): string {
  const extension = ICON_EXTENSION_BY_MIME_TYPE[mimeType ?? ""];
  return extension ? `file.${extension}` : path;
}

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
] as const;

const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

const AUDIO_MIME_TYPE_BY_EXTENSION = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".flac", "audio/flac"],
  [".aac", "audio/aac"],
  [".m4a", "audio/mp4"],
  [".opus", "audio/ogg"],
  [".aiff", "audio/aiff"],
  [".webm-audio", "audio/webm"],
  [".weba", "audio/webm"],
]);

export function audioMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9-]+$/i.test(extension)) return null;
  return AUDIO_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}

/** Classifies a literal filesystem extension, without URL decoding or suffix removal. */
export function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    IMAGE_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    videoMimeType({ name: `media${extension}`, mimeType: "" })
  );
}

/** Classifies an authored media path or URL. Filesystem validation uses the literal extension. */
export function mediaMimeType(path: string): string | null {
  const trimmed = path.trim();
  const source = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const dataMimeType = /^data:((?:image|video|audio)\/[\w.+-]+)[;,]/i.exec(source)?.[1];
  if (dataMimeType) return dataMimeType.toLowerCase();

  let sourcePath = source.split(/[?#]/, 1)[0] ?? "";
  if (/^(?:https?:|file:|\/\/)/i.test(source)) {
    try {
      sourcePath = new URL(source, "https://media.invalid").pathname;
    } catch {
      return null;
    }
  }
  try {
    sourcePath = decodeURIComponent(sourcePath);
  } catch {}
  const basename = sourcePath.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex < 0
    ? null
    : (mediaMimeTypeFromExtension(basename.slice(extensionIndex)) ??
        audioMimeTypeFromExtension(basename.slice(extensionIndex)));
}

export function mediaKindFromPath(path: string): "image" | "video" | "audio" | null {
  const mimeType = mediaMimeType(path);
  if (mimeType === null) return null;
  return mimeType.startsWith("audio/")
    ? "audio"
    : mimeType.startsWith("video/")
      ? "video"
      : "image";
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  const literalPath = path.toLowerCase();
  return WORKSPACE_IMAGE_PREVIEW_EXTENSIONS.some((extension) => literalPath.endsWith(extension));
}

export function isWorkspaceAudioPreviewPath(path: string): boolean {
  const extensionIndex = path.lastIndexOf(".");
  return extensionIndex >= 0 && audioMimeTypeFromExtension(path.slice(extensionIndex)) !== null;
}
