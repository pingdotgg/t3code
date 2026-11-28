import { imageMimeTypeFromBytes } from "@t3tools/shared/image";

export function fileHeaderMimeType(bytes: Uint8Array): string | undefined {
  const imageMimeType = imageMimeTypeFromBytes(bytes);
  if (imageMimeType) return imageMimeType;
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06]))
    return "application/zip";
  const header = new TextDecoder().decode(bytes);
  if (header.startsWith("%PDF-")) return "application/pdf";
  if (header.startsWith("SQLite format 3\0")) return "application/vnd.sqlite3";
  if (!header.startsWith("#!")) return undefined;
  const interpreter = header.split("\n", 1)[0] ?? "";
  if (/\bpython[\d.]*\b/.test(interpreter)) return "text/x-python";
  if (/\b(?:node|nodejs)\b/.test(interpreter)) return "text/javascript";
  if (/\bruby\b/.test(interpreter)) return "text/x-ruby";
  if (/\b(?:sh|bash|zsh|fish)\b/.test(interpreter)) return "text/x-shellscript";
  return undefined;
}
