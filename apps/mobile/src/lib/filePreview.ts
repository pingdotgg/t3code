/** MIME metadata wins; use the extension for files reported without a specific type. */
export function isPdfFile(file: { readonly name: string; readonly mimeType?: string }): boolean {
  const mimeType = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType && mimeType !== "application/octet-stream") return mimeType === "application/pdf";
  return /\.pdf$/i.test(file.name.split(/[?#]/, 1)[0] ?? "");
}
