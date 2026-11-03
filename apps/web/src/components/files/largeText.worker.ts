import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import {
  LARGE_TEXT_MAX_BYTES,
  LARGE_TEXT_MAX_ROWS,
  LARGE_TEXT_MAX_COLUMNS,
  PREVIEW_PAGE_ROWS,
  type TextPreviewRequest,
  type TextPreviewResult,
} from "./largeTextProtocol";

const chunks: { start: number; blob: Blob }[] = [];
const offsets: Uint32Array[] = [new Uint32Array(65536)];
let entries = 1;
let size = 0;
let delimiter: "," | "\t" | null = null;
let complete = false;
let columns = 1;
function reply(value: TextPreviewResult) {
  self.postMessage(value, { transfer: [] });
}
function at(index: number) {
  return offsets[index >>> 16]![index & 65535]!;
}
function set(index: number, value: number) {
  offsets[index >>> 16] ??= new Uint32Array(65536);
  offsets[index >>> 16]![index & 65535] = value;
}
async function read(start: number, end: number) {
  let low = 0;
  let high = chunks.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (chunks[mid]!.start <= start) low = mid;
    else high = mid;
  }
  const parts: Blob[] = [];
  for (let i = low; i < chunks.length; i++) {
    const part = chunks[i]!;
    if (part.start >= end) break;
    parts.push(part.blob.slice(Math.max(0, start - part.start), end - part.start));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(parts).arrayBuffer());
}
async function page(index: number) {
  const start = index * PREVIEW_PAGE_ROWS;
  const end = Math.min(entries - 1, start + PREVIEW_PAGE_ROWS);
  if (start >= end) return;
  const text = await read(at(start), at(end));
  const rows = delimiter
    ? parseDelimitedPreview(text, delimiter, {
        maxRows: PREVIEW_PAGE_ROWS,
        maxColumns: LARGE_TEXT_MAX_COLUMNS,
        maxCellLength: 1024 * 1024,
      }).rows
    : text
        .replace(/\r?\n$|\r$/, "")
        .split(/\r\n|\n|\r/)
        .map((line) => [line]);
  reply({ type: "page", index, rows });
}
async function open(input: Extract<TextPreviewRequest, { type: "open" }>) {
  delimiter = input.delimiter;
  let response =
    input.sizeBytes === 0
      ? new Response(new Blob([]))
      : input.text !== undefined
        ? new Response(new Blob([input.text]))
        : await fetch(input.src!, {
            headers: { Range: `bytes=0-${LARGE_TEXT_MAX_BYTES}` },
            cache: "no-store",
          });
  if (response.status === 416 && response.headers.get("content-range") === "bytes */0") {
    await response.body?.cancel();
    response = new Response(new Blob([]));
  }
  if (!response.ok || !response.body)
    throw new Error("The file could not be loaded. Close it and try again.");
  const total = Number(
    response.headers.get("content-range")?.split("/")[1] ?? response.headers.get("content-length"),
  );
  if (total > LARGE_TEXT_MAX_BYTES) {
    await response.body.cancel();
    throw new Error("Text previews support files up to 256 MB.");
  }
  const reader = response.body.getReader();
  let state = 0;
  let fieldStart = true;
  let cr = false;
  let rowColumns = 1;
  let first = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > LARGE_TEXT_MAX_BYTES)
        throw new Error("Text previews support files up to 256 MB.");
      chunks.push({ start: size, blob: new Blob([value]) });
      for (let i = 0; i < value.length; i++) {
        const byte = value[i]!;
        const pos = size + i;
        if (
          (pos === 0 && byte === 239) ||
          (pos === 1 && byte === 187) ||
          (pos === 2 && byte === 191)
        )
          continue;
        if (byte === 0) throw new Error("This file contains binary data.");
        if (pos - at(entries - 1) > 1024 * 1024)
          throw new Error("A line or record exceeds the 1 MB preview limit.");
        if (cr) {
          cr = false;
          if (byte === 10) {
            set(entries - 1, pos + 1);
            continue;
          }
        }
        if (delimiter) {
          if (state === 1) {
            if (byte === 34) state = 2;
            continue;
          }
          if (state === 2) {
            if (byte === 34) {
              state = 1;
              continue;
            }
            state = 0;
          }
          if (byte === 34 && fieldStart) {
            state = 1;
            fieldStart = false;
            continue;
          }
          if (byte === delimiter.charCodeAt(0)) {
            rowColumns++;
            fieldStart = true;
            continue;
          }
        }
        if (byte === 10 || byte === 13) {
          if (entries > LARGE_TEXT_MAX_ROWS)
            throw new Error("Text previews support up to 5 million rows.");
          set(entries++, pos + 1);
          columns = Math.min(LARGE_TEXT_MAX_COLUMNS, Math.max(columns, rowColumns));
          rowColumns = 1;
          fieldStart = true;
          cr = byte === 13;
        } else fieldStart = false;
      }
      size += value.length;
      if (!first && entries > 1) {
        reply({ type: "meta", count: entries - 1, columns, complete: false, sizeBytes: size });
        await page(0);
        first = true;
      }
    }
    if (total > 0 && size !== total)
      throw new Error("The file download was incomplete. Close it and try again.");
    if (size > at(entries - 1)) {
      if (entries > LARGE_TEXT_MAX_ROWS)
        throw new Error("Text previews support up to 5 million rows.");
      set(entries++, size);
      columns = Math.min(LARGE_TEXT_MAX_COLUMNS, Math.max(columns, rowColumns));
    }
    complete = true;
    reply({ type: "meta", count: entries - 1, columns, complete, sizeBytes: size });
    await page(0);
  } finally {
    await reader.cancel();
  }
}
self.addEventListener("message", (event: MessageEvent<TextPreviewRequest>) => {
  const input = event.data;
  void (
    input.type === "open"
      ? open(input)
      : input.type === "page"
        ? page(input.index)
        : complete
          ? read(0, size).then((text) => reply({ type: "copy", text }))
          : Promise.reject(new Error("Wait for the file to finish loading before copying."))
  ).catch((cause: unknown) =>
    reply({
      type: "error",
      operation: input.type,
      message: cause instanceof Error ? cause.message : "Could not read this file.",
    }),
  );
});
