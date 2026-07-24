import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

export function normalizeGeneratedImageReference(value: string): string | null {
  const reference = value.trim().replaceAll("\\", "/");
  const segments = reference.split("/");
  return !reference.startsWith("/") &&
    !reference.includes(":") &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    isWorkspaceImagePreviewPath(reference)
    ? reference
    : null;
}
