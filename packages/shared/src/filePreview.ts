import { videoMimeType } from "./video.ts";

export type FilePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "html"
  | "markdown"
  | "text"
  | "unsupported";

/** Content classification is identical for captured attachments and workspace references. */
export function filePreviewKind(file: {
  readonly name: string;
  readonly mimeType?: string;
}): FilePreviewKind {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const name = file.name.toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  const generic = !mime || mime === "application/octet-stream" || mime === "text/plain";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (generic) {
    if (extension === ".pdf") return "pdf";
    if (/^\.html?$/.test(extension)) return "html";
    if (/^\.(md|markdown|mdown|mkd|mdx)$/.test(extension)) return "markdown";
    const media = mediaMimeTypeFromExtension(extension);
    if (media?.startsWith("image/")) return "image";
    if (media?.startsWith("video/")) return "video";
    if (audioMimeTypeFromExtension(extension) !== null) return "audio";
    if (
      /^\.(txt|log|json|jsonc|jsonl|ndjson|yaml|yml|toml|ini|conf|config|env|csv|tsv|xml|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|rb|go|rs|swift|kt|kts|java|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|gql|vue|svelte|r|lua|ex|exs|erl|hs|clj|dart|diff|patch|lock|properties|gradle)$/.test(
        extension,
      ) ||
      /^(dockerfile|makefile|gemfile|rakefile|license|readme|\.gitignore|\.gitattributes|\.editorconfig|\.env)(\.|$)/i.test(
        name.split(/[\\/]/).at(-1) ?? "",
      )
    )
      return "text";
  }
  if (
    mime.startsWith("text/") ||
    /^(application\/(json|.*\+json|xml|.*\+xml|javascript|x-javascript|yaml|x-yaml|toml|sql))$/.test(
      mime,
    )
  )
    return "text";
  return "unsupported";
}

export const FILE_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/** Reject binary data rather than displaying replacement characters as a document. */
export function decodeFilePreviewText(bytes: Uint8Array, truncated = false) {
  const bounded = bytes.subarray(0, FILE_TEXT_PREVIEW_MAX_BYTES);
  if (bounded.some((byte) => byte === 0))
    throw new Error("This file contains binary data and cannot be shown as text.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return {
      text: decoder.decode(bounded, { stream: truncated || bytes.length > bounded.length }),
      truncated: truncated || bytes.length > bounded.length,
    };
  } catch {
    throw new Error("This file is not UTF-8 text. Open it in another app to view its contents.");
  }
}

export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const BROWSER_MIME_TYPE_BY_EXTENSION = new Map([
  [".htm", "text/html"],
  [".html", "text/html"],
  [".pdf", "application/pdf"],
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
]);

/** Audio a player can request inline; the server serves these with byte ranges like video. */
export function audioMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
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

/** Files the server serves in place from anywhere on its host: media, audio and browser documents. */
export function hostPreviewMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    mediaMimeTypeFromExtension(extension) ??
    audioMimeTypeFromExtension(extension) ??
    BROWSER_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    null
  );
}

/** Classifies an authored media path or URL. Filesystem validation uses the literal extension. */
export function mediaMimeType(path: string): string | null {
  const trimmed = path.trim();
  const source = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const dataMimeType = /^data:((?:image|video)\/[\w.+-]+)[;,]/i.exec(source)?.[1];
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
  } catch {
    // A literal percent character is valid in a filename.
  }
  const basename = sourcePath.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex < 0 ? null : mediaMimeTypeFromExtension(basename.slice(extensionIndex));
}

export function mediaKindFromPath(path: string): "image" | "video" | null {
  const mimeType = mediaMimeType(path);
  if (mimeType === null) return null;
  return mimeType.startsWith("video/") ? "video" : "image";
}

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

/** File viewers receive literal filesystem paths, not Markdown URLs. */
export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return videoMimeType({ name: path, mimeType: "" }) !== null;
}

export function isWorkspaceAudioPreviewPath(path: string): boolean {
  const extensionIndex = path.lastIndexOf(".");
  return extensionIndex >= 0 && audioMimeTypeFromExtension(path.slice(extensionIndex)) !== null;
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}
