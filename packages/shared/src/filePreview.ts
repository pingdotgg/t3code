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

// Formats Chromium can decode natively; .mov/.m4v only when they carry H.264.
export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [".m4v", ".mov", ".mp4", ".webm"] as const;

export const WORKSPACE_AUDIO_PREVIEW_EXTENSIONS = [".flac", ".m4a", ".mp3", ".ogg", ".wav"] as const;

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

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

export function isWorkspaceAudioPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_AUDIO_PREVIEW_EXTENSIONS);
}

/** Image, video, or audio: previewed via a signed asset URL instead of a file read. */
export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return (
    isWorkspaceImagePreviewPath(path) ||
    isWorkspaceVideoPreviewPath(path) ||
    isWorkspaceAudioPreviewPath(path)
  );
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceMediaPreviewPath(path);
}
