export function resolveEditorFileLabel(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments.at(-1) ?? filePath;
}
