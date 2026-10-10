/** Formats whose headers give extensionless files a useful icon. This is a
 * presentation hint, never a validation of a file's contents or safety. */
export function fileHeaderMimeType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  const header = new TextDecoder().decode(bytes);
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
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
