import type { Database } from "sql.js";

import { boundedZip } from "./boundedZip";
import {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
  BINARY_PREVIEW_MAX_BYTES,
  SQLITE_PAGE_SIZE,
  type ArchiveEntry,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";

let database: Database | null = null;
let tables: string[] = [];
let files = new Map<string, Uint8Array<ArrayBuffer>>();
const reply = (result: BinaryWorkerResult) => self.postMessage(result, { transfer: [] });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function gunzip(bytes: ArrayBuffer) {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > BINARY_PREVIEW_MAX_BYTES || length > bytes.byteLength * ARCHIVE_MAX_RATIO)
        throw new Error(
          "The expanded archive exceeds the preview size or compression ratio limit.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

function tarEntries(bytes: Uint8Array<ArrayBuffer>) {
  const entries: ArchiveEntry[] = [];
  const text = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length)).split("\0", 1)[0] ?? "";
  const number = (offset: number, length: number) => {
    const value = text(offset, length).trim();
    if (!/^[0-7]*$/.test(value)) throw new Error("This TAR uses an unsupported numeric format.");
    return Number.parseInt(value || "0", 8);
  };
  let longPath: string | null = null;
  const globalPax: Record<string, string> = {};
  let localPax: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    if (entries.length >= ARCHIVE_MAX_ENTRIES)
      throw new Error("This archive contains more than 2,048 entries.");
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : bytes[offset + index]!;
    if (checksum !== number(offset + 148, 8)) throw new Error("The TAR header is damaged.");
    const type = text(offset + 156, 1);
    const metadata = type === "L" || type === "x" || type === "g";
    const attributes: Record<string, string> = metadata ? {} : { ...globalPax, ...localPax };
    const size = attributes.size ? Number(attributes.size) : number(offset + 124, 12);
    if (attributes.size && !/^\d+$/.test(attributes.size))
      throw new Error("An archive entry is too large or damaged.");
    const prefix =
      text(offset + 257, 6) === "ustar" && text(offset + 263, 2) === "00"
        ? text(offset + 345, 155)
        : "";
    const path =
      attributes.path || longPath || [prefix, text(offset, 100)].filter(Boolean).join("/");
    if (!metadata) {
      longPath = null;
      localPax = {};
    }
    if (
      path.length > 1024 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > BINARY_PREVIEW_MAX_BYTES ||
      offset + 512 + size > bytes.length
    )
      throw new Error("An archive entry is too large or damaged.");
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === "L") longPath = new TextDecoder().decode(content).replace(/\0.*$/s, "");
    else if (type === "x" || type === "g") {
      if (size > 65536) throw new Error("Archive metadata is too large.");
      for (let cursor = 0; cursor < content.length;) {
        const separator = content.indexOf(32, cursor);
        if (separator < cursor || separator - cursor > 10)
          throw new Error("The TAR metadata is damaged.");
        const lengthText = new TextDecoder().decode(content.subarray(cursor, separator));
        const length = Number(lengthText);
        const end = cursor + length;
        if (
          !/^[1-9]\d*$/.test(lengthText) ||
          !Number.isSafeInteger(length) ||
          end > content.length ||
          end <= separator + 1 ||
          content[end - 1] !== 10
        )
          throw new Error("The TAR metadata is damaged.");
        const record = new TextDecoder().decode(content.subarray(separator + 1, end - 1));
        const equals = record.indexOf("=");
        if (equals < 1) throw new Error("The TAR metadata is damaged.");
        const key = record.slice(0, equals);
        const value = record.slice(equals + 1);
        if (["path", "size", "mtime"].includes(key)) {
          if (type === "x") localPax[key] = value;
          else if (value) globalPax[key] = value;
          else delete globalPax[key];
        }
        cursor = end;
      }
    } else if (type === "" || type === "0" || type === "5") {
      if (attributes.mtime && !/^[+-]?\d+(?:\.\d+)?$/.test(attributes.mtime))
        throw new Error("The TAR metadata is damaged.");
      const modified =
        (attributes.mtime ? Number(attributes.mtime) : number(offset + 136, 12)) * 1000;
      const date = new Date(modified);
      entries.push({
        path,
        size,
        directory: type === "5",
        modified: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      });
      if (type !== "5") files.set(path, content.slice());
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error("This archive has no readable entries.");
  return entries;
}

async function handle(input: BinaryWorkerRequest) {
  if (input.type === "entry") {
    const bytes = files.get(input.path);
    if (!bytes) throw new Error("This archive entry is unavailable.");
    if (bytes.length > ARCHIVE_ENTRY_MAX_BYTES)
      throw new Error("Entry previews are limited to 10 MB.");
    reply({ type: "entry", path: input.path, bytes });
    return;
  }
  if (input.type === "rows") {
    if (
      !database ||
      !tables.includes(input.table) ||
      !Number.isSafeInteger(input.page) ||
      input.page < 0
    )
      throw new Error("This table is unavailable.");
    const columns =
      database
        .exec(`PRAGMA table_xinfo(${quote(input.table)})`)[0]
        ?.values.filter((row) => row[6] !== 1)
        .map((row) => String(row[1]))
        .slice(0, 50) ?? [];
    const fields = columns.map((name) => {
      const field = quote(name);
      return `CASE WHEN typeof(${field}) = 'blob' THEN '[blob: ' || length(${field}) || ' bytes]' ELSE substr(CAST(${field} AS TEXT), 1, 1024) END`;
    });
    const result = database.exec(
      `SELECT ${fields.join(",")} FROM ${quote(input.table)} LIMIT ${SQLITE_PAGE_SIZE} OFFSET ${input.page * SQLITE_PAGE_SIZE}`,
    )[0];
    reply({
      type: "rows",
      table: input.table,
      page: input.page,
      columns,
      rows:
        result?.values.map((row) => row.map((cell) => (cell === null ? "NULL" : String(cell)))) ??
        [],
    });
    return;
  }
  if (input.bytes.byteLength > BINARY_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  if (input.kind === "sqlite") {
    const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
      import("sql.js"),
      import("sql.js/dist/sql-wasm.wasm?url"),
    ]);
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    database = new SQL.Database(new Uint8Array(input.bytes));
    database.run("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    tables =
      database
        .exec(
          "SELECT name FROM sqlite_schema WHERE type='table' AND substr(name, 1, 7) != 'sqlite_' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name LIMIT 101",
        )[0]
        ?.values.map((row) => String(row[0])) ?? [];
    if (tables.length > 100) throw new Error("Database previews are limited to 100 tables.");
    reply({
      type: "sqlite",
      tables: tables.map((name) => ({
        name,
        count: Number(
          database!.exec(`SELECT count(*) FROM ${quote(name)}`)[0]?.values[0]?.[0] ?? 0,
        ),
      })),
    });
  } else {
    files = new Map();
    let entries: ArchiveEntry[];
    if (
      /\.(zip|jar)$/i.test(input.name) ||
      (input.bytes.byteLength >= 4 &&
        [0x04034b50, 0x06054b50].includes(new DataView(input.bytes).getUint32(0, true)))
    ) {
      const archive = await boundedZip(input.bytes, BINARY_PREVIEW_MAX_BYTES);
      entries = [...archive].map(([path, file]) => {
        files.set(path, file.bytes);
        return {
          path,
          size: file.bytes.length,
          directory: file.directory,
          modified: Number.isNaN(file.date.getTime()) ? null : file.date.toISOString(),
        };
      });
    } else if (/\.(gz|tgz)$/i.test(input.name) || new Uint8Array(input.bytes)[0] === 0x1f) {
      const bytes = await gunzip(input.bytes);
      if (/\.(tar\.gz|tgz)$/i.test(input.name)) entries = tarEntries(bytes);
      else {
        const path = input.name.replace(/\.gz$/i, "") || "contents";
        if (/\.tar$/i.test(path)) entries = tarEntries(bytes);
        else {
          files.set(path, bytes);
          entries = [{ path, size: bytes.length, directory: false, modified: null }];
        }
      }
    } else entries = tarEntries(new Uint8Array(input.bytes));
    reply({ type: "archive", entries });
  }
}

self.addEventListener("message", (event: MessageEvent<BinaryWorkerRequest>) => {
  void handle(event.data).catch((cause: unknown) =>
    reply({
      type: "error",
      message: cause instanceof Error ? cause.message : "Could not preview this file.",
    }),
  );
});
