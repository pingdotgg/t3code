import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { statMediaFile, type OpenMediaFile } from "../assets/MediaFile.ts";

// Files read from disk may load scripts, styles, fonts and images over https, but make no requests of
// their own (fetch, sockets, beacons, form posts) and frame no addresses.
// Never add a nonce or hash to script-src: it disables the 'unsafe-inline' pages rely on.
export const FILE_PAGE_NETWORK_POLICY = [
  "default-src 'none'",
  "script-src 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' https: 'unsafe-inline' data:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' data: blob:",
  "worker-src blob:",
  "connect-src data: blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

class FilePageReadError extends Schema.TaggedError<FilePageReadError>()("FilePageReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read page '${this.path}'.`;
  }
}

// The same bound readMcpAppHtml applies to pages read by path.
const FILE_PAGE_MAX_BYTES = MCP_APP_MAX_HTML_BYTES + 128 * 1024;

// Positional reads leave the handle open; a read stream would close it on teardown.
export const readPinnedFilePage = Effect.fn("FilePagePolicy.readPinnedFilePage")(function* (
  filePath: string,
  file: OpenMediaFile,
) {
  if ((yield* statMediaFile(filePath, file)).size > BigInt(FILE_PAGE_MAX_BYTES)) return null;
  const bytes = yield* Effect.tryPromise({
    try: async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size <= FILE_PAGE_MAX_BYTES) {
        const chunk = new Uint8Array(Math.min(64 * 1024, FILE_PAGE_MAX_BYTES + 1 - size));
        const { bytesRead } = await file.handle.read(chunk, 0, chunk.byteLength, size);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        size += bytesRead;
      }
      return Buffer.concat(chunks, size);
    },
    catch: (cause) => new FilePageReadError({ path: filePath, cause }),
  });
  return bytes.byteLength > FILE_PAGE_MAX_BYTES ? null : bytes;
});

// The browser would decode the appended UTF-8 script as UTF-16.
export const isUtf16ByteOrderMark = (bytes: Uint8Array): boolean =>
  (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe);
