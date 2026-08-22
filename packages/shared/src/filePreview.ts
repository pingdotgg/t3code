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

export const WORKSPACE_MODEL_PREVIEW_EXTENSIONS = [".glb"] as const;

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

export function isWorkspaceModelPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_MODEL_PREVIEW_EXTENSIONS);
}

const WORKSPACE_PREVIEW_ENTRY_EXTENSIONS = [
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ...WORKSPACE_MODEL_PREVIEW_EXTENSIONS,
] as const;

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_PREVIEW_ENTRY_EXTENSIONS);
}
