// Only document-like formats may be opened in the host's default app.
const DOCUMENT_KINDS = [
  [/^(ppt|pptx)$/, "PowerPoint presentation"],
  [/^(doc|docx|rtf)$/, "Word document"],
  [/^(xls|xlsx|ods)$/, "Spreadsheet"],
  [/^odp$/, "OpenDocument presentation"],
  [/^odt$/, "OpenDocument text"],
  [/^pages$/, "Pages document"],
  [/^numbers$/, "Numbers spreadsheet"],
  [/^key$/, "Keynote presentation"],
  [/^(zip|gz|bz2|xz|7z|rar|tar)$/, "Archive"],
  [/^(ttf|otf|woff|woff2)$/, "Font"],
  [/^(glb|gltf|obj|stl|fbx|usdz)$/, "3D model"],
  [/^(png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|ico|psd)$/, "Image"],
  [/^(mp3|wav|flac|ogg|m4a|aac|aiff)$/, "Audio"],
  [/^(mp4|webm|mov|mkv|avi|m4v)$/, "Video"],
  [/^pdf$/, "PDF document"],
] as const;

export function binaryFileInfo(path: string) {
  const name = path.split(/[/\\]/).at(-1) ?? path;
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  const match = extension && DOCUMENT_KINDS.find(([pattern]) => pattern.test(extension));
  return {
    name,
    kind: match ? match[1] : extension ? `${extension.toUpperCase()} file` : "Binary file",
    canOpenDefault: Boolean(match),
  };
}

/**
 * The file menu resolves a path under a root, so a file is named relative to
 * its own folder. That works the same for workspace and host files.
 */
export function fileMenuTarget(absolutePath: string) {
  const separator = Math.max(absolutePath.lastIndexOf("/"), absolutePath.lastIndexOf("\\"));
  return {
    filePath: absolutePath.slice(separator + 1),
    workspaceRoot: absolutePath.slice(0, separator) || absolutePath.slice(0, 1),
  };
}
