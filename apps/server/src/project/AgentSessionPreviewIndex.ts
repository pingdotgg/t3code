// @effect-diagnostics nodeBuiltinImport:off - incremental hashing must retain its state between bounded requests.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import { createTranscriptJsonReader, TranscriptJsonLimitError } from "./AgentSessionJson.ts";

type ReaderOptions = Parameters<typeof createTranscriptJsonReader>;

interface PreviewRecord {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly session?: boolean;
  readonly role?: "user" | "assistant";
  readonly text?: string;
  readonly createdAt?: string;
  readonly canonical?: boolean;
  readonly turnId?: string | null;
}

// Only this disposable index contains transcript text; cursors never contain paths or parser state.
export function createPreviewIndex(
  filename: string,
  source: string,
  selectPath: ReaderOptions[1],
  decode: (value: unknown) => PreviewRecord | undefined,
) {
  const db = new NodeSqlite.DatabaseSync(filename);
  try {
    db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = -2048;
    CREATE TABLE chunks (id INTEGER, start INTEGER, end INTEGER, text BLOB);
    CREATE INDEX chunk_end ON chunks(id, end);
    CREATE TABLE parts (message INTEGER, start INTEGER, end INTEGER, id INTEGER, offset INTEGER);
    CREATE INDEX part_end ON parts(message, end);
    CREATE TABLE records (
      offset INTEGER PRIMARY KEY, id TEXT, parent TEXT, role TEXT, created TEXT,
      length INTEGER, turn INTEGER, groupTurn INTEGER, canonical INTEGER, turnId TEXT, hash TEXT,
      hashStart INTEGER, hashEnd INTEGER, displayStart INTEGER DEFAULT 0,
      pending INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0
    );
    CREATE INDEX pending_response ON records(turn, hash, offset) WHERE pending=1;
    CREATE INDEX record_text ON records(offset) WHERE length>0;
    CREATE TABLE pages (step INTEGER PRIMARY KEY, input TEXT, result TEXT);
    CREATE INDEX record_id ON records(id, offset);
    CREATE INDEX record_group_hash ON records(groupTurn, hash, canonical);
    CREATE INDEX record_hash ON records(turn, hash, canonical);
    CREATE TABLE canonical_groups (turn INTEGER, id TEXT, PRIMARY KEY(turn, id));
    `);
  } catch (cause) {
    db.close();
    throw cause;
  }
  const insertChunk = db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO parts VALUES (?, ?, ?, ?, ?)");
  const insertRecord = db.prepare(`INSERT INTO records
    (offset,id,parent,role,created,length,turn,groupTurn,canonical,turnId,hashStart,hashEnd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let stringId = 0;
  let recordCount = 0;
  let recordOffset = 0;
  let offset = 0;
  let turn = 0;
  let groupTurn = 0;
  let leaf: number | undefined;
  let tree = false;
  let selectedBytes = 0;
  const strings = new Map<
    string,
    { id: number; start: number; end: number; trimStart: number; trimEnd: number }
  >();
  const makeReader = () =>
    createTranscriptJsonReader(
      (bytes) => {
        selectedBytes += bytes;
        if (selectedBytes > 32 * 1024 * 1024)
          throw new TranscriptJsonLimitError("Transcript metadata exceeds the memory budget");
      },
      selectPath,
      {
        streamString: (path) => {
          const text =
            (path.length === 2 && path[0] === "message" && path[1] === "content") ||
            (path.length === 2 && path[0] === "payload" && path[1] === "message") ||
            (path.length === 4 &&
              (path[0] === "message" || path[0] === "payload") &&
              path[1] === "content" &&
              typeof path[2] === "number" &&
              path[3] === "text");
          if (!text) return undefined;
          const id = ++stringId;
          let length = 0;
          let pending = "";
          const flush = () => {
            if (!pending) return;
            insertChunk.run(id, length - pending.length, length, Buffer.from(pending, "utf16le"));
            pending = "";
          };
          let start: number | undefined;
          let end = 0;
          return {
            write: (chunk) => {
              if (chunk.length === 0) return;
              pending += chunk;
              const first = chunk.search(/\S/u);
              if (first !== -1) {
                start ??= length + first;
                end = length + chunk.trimEnd().length;
              }
              length += chunk.length;
              if (pending.length >= 16_384) flush();
            },
            finish: () => {
              flush();
              if (start === undefined) return "";
              const key = `\0${id}\0`;
              strings.set(key, {
                id,
                start: path[0] === "payload" && path[1] === "message" ? 0 : start,
                end: path[0] === "payload" && path[1] === "message" ? length : end,
                trimStart: start,
                trimEnd: end,
              });
              return key;
            },
          };
        },
      },
    );
  let reader = makeReader();
  let decoder = new TextDecoder();
  const finishRecord = () => {
    recordCount++;
    reader.write(decoder.decode());
    const record = decode(reader.finish());
    if (record && !record.session) {
      let length = 0;
      let hashStart = 0;
      let hashEnd = 0;
      for (const key of record.text?.split("\n") ?? []) {
        const value = strings.get(key);
        if (!value) continue;
        if (length > 0) {
          insertPart.run(recordOffset, length, length + 1, 0, 0);
          length++;
        }
        const size = value.end - value.start;
        if (length === 0) hashStart = value.trimStart - value.start;
        hashEnd = length + value.trimEnd - value.start;
        insertPart.run(recordOffset, length, length + size, value.id, value.start);
        length += size;
      }
      insertRecord.run(
        recordOffset,
        record.id ?? null,
        record.parentId ?? null,
        record.role ?? null,
        record.createdAt ?? null,
        length,
        turn,
        groupTurn,
        record.canonical ? 1 : 0,
        record.turnId ?? null,
        hashStart,
        hashEnd,
      );
      leaf = recordOffset;
      tree = record.id !== undefined;
      if (source === "codex" && record.role === "assistant") {
        groupTurn++;
        if (length > 0) turn++;
      }
    }
    strings.clear();
    selectedBytes = 0;
    reader = makeReader();
    decoder = new TextDecoder();
  };
  const readText = (message: number, start: number, end: number) => {
    let text = "";
    const parts = db
      .prepare("SELECT * FROM parts WHERE message=? AND end>? AND start<? ORDER BY end")
      .all(message, start, end);
    for (const part of parts) {
      const partStart = Number(part.start);
      const from = Math.max(start, partStart) - partStart + Number(part.offset);
      const to = Math.min(end, Number(part.end)) - partStart + Number(part.offset);
      if (part.id === 0) {
        text += "\n";
        continue;
      }
      const chunks = db
        .prepare(`SELECT start, substr(text, (max(?,start)-start)*2+1,
        (min(?,end)-max(?,start))*2) AS text FROM chunks
        WHERE id=? AND end>? AND start<? ORDER BY end`)
        .all(from, to, from, part.id!, from, to);
      for (const chunk of chunks) {
        if (chunk.text instanceof Uint8Array) text += Buffer.from(chunk.text).toString("utf16le");
      }
    }
    return text;
  };
  let phase: "read" | "hash" | "groups" | "dedup" | "ready" = "read";
  let hashOffset = -1;
  let hashing:
    | {
        offset: number;
        length: number;
        position: number;
        hash: ReturnType<typeof NodeCrypto.createHash>;
        prefix: string;
        tail: string;
        markerCount: number;
        markerEnd: number;
      }
    | undefined;
  const marker = "\n\nUser message:\n";
  let groupOffset = -1;
  let dedupOffset = -1;
  let before = Number.MAX_SAFE_INTEGER;
  let textBefore: number | undefined;
  let branch = leaf;
  let complete = false;
  return {
    close: () => db.close(),
    savePage: (step: number, input: string, result: string) => {
      db.prepare("INSERT INTO pages VALUES (?,?,?)").run(step, input, result);
    },
    readPage: (step: number) => {
      const row = db.prepare("SELECT input,result FROM pages WHERE step=?").get(step);
      return row && typeof row.input === "string" && typeof row.result === "string"
        ? { input: row.input, result: row.result }
        : undefined;
    },
    get recordCount() {
      return recordCount;
    },
    get offset() {
      return offset;
    },
    get phase() {
      return phase;
    },
    write: (bytes: Uint8Array, eof: boolean, recordBudget: number) => {
      db.exec("BEGIN");
      try {
        let start = 0;
        let consumed = bytes.length;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start);
          const end = newline === -1 ? bytes.length : newline;
          reader.write(decoder.decode(bytes.subarray(start, end), { stream: true }));
          if (newline === -1) break;
          finishRecord();
          recordOffset = offset + newline + 1;
          start = newline + 1;
          if (--recordBudget === 0) {
            consumed = start;
            break;
          }
        }
        offset += consumed;
        if (eof && consumed === bytes.length) {
          if (offset > recordOffset) finishRecord();
          phase = "hash";
          branch = leaf;
        }
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
    advance: () => {
      let budget = 1024 * 1024;
      let operations = 1000;
      while (phase === "hash" && budget > 0 && operations-- > 0) {
        if (!hashing) {
          const row = db
            .prepare(
              "SELECT offset,length,hashStart,hashEnd FROM records WHERE offset>? AND length>0 ORDER BY offset LIMIT 1",
            )
            .get(hashOffset);
          if (!row) {
            phase = source === "codex" ? "groups" : "ready";
            break;
          }
          hashing = {
            offset: Number(row.offset),
            length: Number(row.hashEnd),
            position: Number(row.hashStart),
            hash: NodeCrypto.createHash("sha256"),
            prefix: readText(Number(row.offset), 0, Math.min(32, Number(row.length))),
            tail: "",
            markerCount: 0,
            markerEnd: 0,
          };
        }
        const end = Math.min(hashing.length, hashing.position + Math.min(16_384, budget));
        const text = readText(hashing.offset, hashing.position, end);
        // UTF-16 hashing is independent of chunk boundaries, including split surrogate pairs.
        hashing.hash.update(Buffer.from(text, "utf16le"));
        const joined = hashing.tail + text;
        let at = joined.indexOf(marker);
        while (at !== -1) {
          hashing.markerCount++;
          hashing.markerEnd = hashing.position - hashing.tail.length + at + marker.length;
          at = joined.indexOf(marker, at + marker.length);
        }
        hashing.tail = joined.slice(-(marker.length - 1));
        budget -= end - hashing.position;
        hashing.position = end;
        if (end === hashing.length) {
          db.prepare("UPDATE records SET hash=?, displayStart=? WHERE offset=?").run(
            hashing.hash.digest("hex"),
            hashing.prefix.startsWith("Context handoff (") && hashing.markerCount === 1
              ? hashing.markerEnd
              : 0,
            hashing.offset,
          );
          hashOffset = hashing.offset;
          hashing = undefined;
        }
      }
      while (phase === "groups" && operations-- > 0) {
        const row = db
          .prepare("SELECT * FROM records WHERE offset>? ORDER BY offset LIMIT 1")
          .get(groupOffset);
        if (!row) {
          phase = "dedup";
          break;
        }
        groupOffset = Number(row.offset);
        if (
          source === "codex" &&
          row.role === "user" &&
          row.canonical === 0 &&
          row.turnId !== null &&
          row.hash !== null &&
          db
            .prepare("SELECT 1 FROM records WHERE groupTurn=? AND hash=? AND canonical=1 LIMIT 1")
            .get(row.groupTurn!, row.hash!)
        ) {
          db.prepare("INSERT OR IGNORE INTO canonical_groups VALUES (?,?)").run(
            row.groupTurn!,
            row.turnId!,
          );
        }
      }
      while (phase === "dedup" && operations-- > 0) {
        const row = db
          .prepare("SELECT * FROM records WHERE offset>? ORDER BY offset LIMIT 1")
          .get(dedupOffset);
        if (!row) {
          phase = "ready";
          break;
        }
        dedupOffset = Number(row.offset);
        if (row.role !== "user" || row.hash === null) continue;
        if (row.canonical === 1) {
          const pending = db
            .prepare(
              "SELECT offset FROM records WHERE turn=? AND hash=? AND pending=1 ORDER BY offset DESC LIMIT 1",
            )
            .get(row.turn!, row.hash!);
          if (pending)
            db.prepare("UPDATE records SET pending=0, hidden=1 WHERE offset=?").run(
              pending.offset!,
            );
        } else {
          const hidden =
            db
              .prepare(
                "SELECT 1 FROM records WHERE turn=? AND hash=? AND canonical=1 AND offset<? LIMIT 1",
              )
              .get(row.turn!, row.hash!, row.offset!) ||
            (row.turnId !== null &&
              db
                .prepare("SELECT 1 FROM canonical_groups WHERE turn=? AND id=?")
                .get(row.groupTurn!, row.turnId!));
          db.prepare("UPDATE records SET pending=?, hidden=? WHERE offset=?").run(
            hidden ? 0 : 1,
            hidden ? 1 : 0,
            row.offset!,
          );
        }
      }
    },
    page: (cutoff: number) => {
      const messages: Array<{
        sourceOffset: number;
        textOffset: number;
        role: "user" | "assistant";
        text: string;
        createdAt: string;
        truncated: boolean;
      }> = [];
      let operations = 1000;
      while (!complete && messages.length < 4 && operations-- > 0) {
        const row =
          source === "pi" && tree
            ? branch === undefined
              ? undefined
              : db.prepare("SELECT * FROM records WHERE offset=?").get(branch)
            : db
                .prepare("SELECT * FROM records WHERE offset<? ORDER BY offset DESC LIMIT 1")
                .get(before);
        if (!row) {
          complete = true;
          break;
        }
        const position = Number(row.offset);
        const length = Number(row.length);
        if (
          position < cutoff &&
          length > 0 &&
          row.hidden === 0 &&
          (row.role === "user" || row.role === "assistant")
        ) {
          const displayStart = row.role === "user" ? Number(row.displayStart) : 0;
          const end = textBefore ?? length;
          let start = Math.max(displayStart, end - 4000);
          let text = readText(position, start, end);
          if (start > displayStart && /^[\uDC00-\uDFFF]/.test(text)) {
            start++;
            text = text.slice(1);
          }
          messages.unshift({
            sourceOffset: position,
            textOffset: start - displayStart,
            role: row.role,
            text,
            createdAt: String(row.created),
            truncated: start > displayStart || end < length,
          });
          if (start > displayStart) {
            textBefore = start;
            break;
          }
        }
        textBefore = undefined;
        before = position;
        if (source === "pi" && tree) {
          const parent =
            row.parent === null
              ? undefined
              : db
                  .prepare(
                    "SELECT offset FROM records WHERE id=? AND offset<? ORDER BY offset DESC LIMIT 1",
                  )
                  .get(row.parent!, position);
          branch = parent ? Number(parent.offset) : undefined;
          if (branch === undefined) complete = true;
        }
      }
      return { messages, complete, textBefore };
    },
  };
}
