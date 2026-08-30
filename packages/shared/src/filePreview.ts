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

/** Files T3 cannot render itself but can download and hand to an external
    viewer app. Keyed by extension; the value is the MIME type sent with the
    handoff intent. Extend deliberately: every entry becomes downloadable
    through an exact-file asset token. */
export const WORKSPACE_EXTERNAL_OPEN_FILE_TYPES = [
  { extension: ".glb", mimeType: "model/gltf-binary" },
] as const;

/** External-open files download whole to the device. The server refuses to
    mint or serve past this cap and the client aborts a download that crosses
    it, so a lying Content-Length cannot fill the device cache. */
export const WORKSPACE_EXTERNAL_OPEN_MAX_BYTES = 100 * 1024 * 1024;

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

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}

/** The handoff MIME type for a path an external app can open, or null when the
    path is not an external-open file. Matches the full workspace filename —
    no query stripping, so a literal "model.glb?x" is not a GLB — and hidden
    files whose whole name is an extension (such as ".glb") stay excluded. */
export function workspaceExternalOpenMimeType(path: string): string | null {
  const baseName = path.toLowerCase().split(/[\\/]/).at(-1) ?? "";
  return (
    WORKSPACE_EXTERNAL_OPEN_FILE_TYPES.find(
      ({ extension }) => baseName.length > extension.length && baseName.endsWith(extension),
    )?.mimeType ?? null
  );
}

export function isWorkspaceExternalOpenPath(path: string): boolean {
  return workspaceExternalOpenMimeType(path) !== null;
}
