import { filePreviewKind, modelPreviewKind } from "@t3tools/shared/filePreview";

export function inlineFilePreviewKind(file: { readonly name: string; readonly mimeType?: string }) {
  return filePreviewKind(file) === "audio" ? "audio" : null;
}

export function isPdfFile(file: { readonly name: string; readonly mimeType?: string }): boolean {
  const mimeType = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType && mimeType !== "application/octet-stream") return mimeType === "application/pdf";
  const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(file.name);
  if (!isUrl && modelPreviewKind(file)) return false;
  return /\.pdf$/i.test(file.name.split(/[?#]/, 1)[0] ?? "");
}
