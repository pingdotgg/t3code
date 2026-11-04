// @effect-diagnostics nodeBuiltinImport:off - resumable directory handles and the disposable index outlive one request.
import type * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { createTranscriptJsonReader, TranscriptJsonLimitError } from "./AgentSessionJson.ts";

export interface DiscoveryHome {
  readonly source: "claudeAgent" | "codex" | "pi";
  readonly homePath: string;
  readonly providerInstanceId: string;
}

export interface DiscoveryFile extends DiscoveryHome {
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly device: number;
  readonly inode: string;
  readonly birthtimeMs: number;
}

export async function readDiscoveryDirectory(directory: string, limit: number) {
  const handle = await NodeFS.promises.opendir(directory);
  try {
    const entries: Array<string> = [];
    while (entries.length < limit) {
      const entry = await handle.read();
      if (!entry) return { entries: entries.sort(), truncated: false };
      entries.push(entry.name);
    }
    return { entries: entries.sort(), truncated: true };
  } finally {
    await handle.close();
  }
}

// Directory entries, records and bytes each consume a budget; no skipped prefix is reread.
export function createSessionDiscovery<
  T extends {
    readonly providerInstanceId: string;
    readonly providerSessionId: string;
    readonly mtimeMs: number;
  },
>(
  filename: string,
  homes: ReadonlyArray<DiscoveryHome>,
  selectPath: Parameters<typeof createTranscriptJsonReader>[1],
  metadata: (file: DiscoveryFile, value: unknown) => T | false | null,
) {
  const db = new NodeSqlite.DatabaseSync(filename);
  try {
    db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = -2048;
    CREATE TABLE sessions (instance TEXT, session TEXT, updated REAL, value TEXT,
      PRIMARY KEY(instance, session));
    CREATE INDEX session_order ON sessions(updated, instance, session);
  `);
  } catch (cause) {
    db.close();
    throw cause;
  }
  const insert = db.prepare(`INSERT INTO sessions VALUES (?,?,?,?)
    ON CONFLICT(instance,session) DO UPDATE SET updated=excluded.updated,value=excluded.value
    WHERE excluded.updated < sessions.updated`);
  const directories: Array<{ directory: NodeFS.Dir; home: DiscoveryHome; depth: number }> = [];
  let homeIndex = 0;
  let pending:
    | {
        file: NodeFSP.FileHandle;
        identity: DiscoveryFile;
        offset: number;
        decoder: InstanceType<typeof TextDecoder>;
        reader: ReturnType<typeof createTranscriptJsonReader>;
      }
    | undefined;
  let complete = false;
  const reader = () => {
    let reserved = 0;
    return createTranscriptJsonReader(
      (bytes) => {
        reserved += bytes;
        if (reserved > 32 * 1024 * 1024)
          throw new TranscriptJsonLimitError("Discovery metadata exceeds the memory budget");
      },
      selectPath,
      {
        streamString: (path) => {
          if (
            !(
              path[0] === "message" ||
              (path[0] === "payload" && (path[1] === "message" || path[1] === "content"))
            )
          )
            return undefined;
          let prefix = "";
          return {
            write: (chunk) => {
              prefix += chunk.slice(0, Math.max(0, 200 - prefix.length));
            },
            finish: () => prefix,
          };
        },
      },
    );
  };
  const identity = (
    home: DiscoveryHome,
    filePath: string,
    stats: Awaited<ReturnType<NodeFSP.FileHandle["stat"]>>,
  ): DiscoveryFile => ({
    ...home,
    filePath,
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    device: Number(stats.dev),
    inode: String(stats.ino),
    birthtimeMs: Number(stats.birthtimeMs),
  });
  const unchanged = async () =>
    pending !== undefined &&
    JSON.stringify(pending.identity) ===
      JSON.stringify(
        identity(
          pending.identity,
          pending.identity.filePath,
          await pending.file.stat({ bigint: true }),
        ),
      );
  const closeFile = async () => {
    const file = pending?.file;
    pending = undefined;
    await file?.close();
  };
  const openDirectory = async (directory: string, home: DiscoveryHome, depth: number) => {
    const handle = await NodeFS.promises.opendir(directory).catch(() => undefined);
    if (handle) directories.push({ directory: handle, home, depth });
  };
  const finishRecord = async () => {
    if (!pending) return;
    const found = metadata(pending.identity, pending.reader.finish());
    if (found !== null) {
      if (found !== false && (await unchanged()))
        insert.run(
          found.providerInstanceId,
          found.providerSessionId,
          -found.mtimeMs,
          JSON.stringify(found),
        );
      await closeFile();
    } else {
      pending.reader = reader();
    }
  };
  return {
    advance: async () => {
      let bytesRemaining = 1024 * 1024;
      let recordsRemaining = 1000;
      let operationsRemaining = 1000;
      if (pending && !(await unchanged())) await closeFile();
      while (!complete && bytesRemaining > 0 && recordsRemaining > 0 && operationsRemaining-- > 0) {
        if (pending) {
          try {
            const bytes = new Uint8Array(Math.min(8192, bytesRemaining, recordsRemaining));
            const { bytesRead } = await pending.file.read({
              buffer: bytes,
              offset: 0,
              length: bytes.length,
              position: pending.offset,
            });
            pending.offset += bytesRead;
            bytesRemaining -= bytesRead;
            if (bytesRead === 0) {
              pending.reader.write(pending.decoder.decode());
              await finishRecord();
              await closeFile();
              continue;
            }
            const parts = pending.decoder
              .decode(bytes.subarray(0, bytesRead), { stream: true })
              .split("\n");
            for (const [index, part] of parts.entries()) {
              if (!pending) break;
              pending.reader.write(part);
              if (index < parts.length - 1) {
                recordsRemaining--;
                await finishRecord();
              }
            }
          } catch (cause) {
            await closeFile();
            if (
              !(cause instanceof TranscriptJsonLimitError) &&
              !(
                cause instanceof Error &&
                "code" in cause &&
                typeof cause.code === "string" &&
                /^E[A-Z0-9]+$/.test(cause.code)
              )
            )
              throw cause;
          }
          continue;
        }
        const current = directories.at(-1);
        if (!current) {
          const home = homes[homeIndex++];
          if (!home) {
            complete = true;
            break;
          }
          await openDirectory(
            NodePath.join(
              home.homePath,
              home.source === "claudeAgent"
                ? "projects"
                : home.source === "codex"
                  ? "sessions"
                  : "",
            ),
            home,
            0,
          );
          continue;
        }
        const entry = await current.directory.read().catch(() => null);
        if (!entry) {
          await current.directory.close();
          directories.pop();
          continue;
        }
        const filePath = NodePath.join(current.directory.path, entry.name);
        const depth = current.home.source === "codex" ? 3 : 1;
        if (
          current.depth < depth &&
          !(current.home.source === "pi" && entry.name.endsWith(".jsonl"))
        ) {
          await openDirectory(filePath, current.home, current.depth + 1);
          continue;
        }
        if (
          !entry.name.endsWith(".jsonl") ||
          (current.home.source === "codex" && !entry.name.startsWith("rollout-"))
        )
          continue;
        const file = await NodeFS.promises.open(filePath, "r").catch(() => undefined);
        if (!file) continue;
        try {
          const stats = await file.stat({ bigint: true });
          if (!stats.isFile()) {
            await file.close();
            continue;
          }
          pending = {
            file,
            identity: identity(current.home, filePath, stats),
            offset: 0,
            decoder: new TextDecoder(),
            reader: reader(),
          };
        } catch {
          await file.close();
        }
      }
      return complete;
    },
    page: (after?: {
      updatedAt: string;
      providerInstanceId: string;
      providerSessionId: string;
    }) => {
      const rows =
        after === undefined
          ? db
              .prepare("SELECT value FROM sessions ORDER BY updated, instance, session LIMIT 501")
              .all()
          : db
              .prepare(`SELECT value FROM sessions WHERE (updated,instance,session) > (?,?,?)
          ORDER BY updated, instance, session LIMIT 501`)
              .all(-Date.parse(after.updatedAt), after.providerInstanceId, after.providerSessionId);
      return rows.map((row) => JSON.parse(String(row.value)) as T);
    },
    find: (instance: string, session: string): T | undefined => {
      const row = db
        .prepare("SELECT value FROM sessions WHERE instance=? AND session=?")
        .get(instance, session);
      return row ? (JSON.parse(String(row.value)) as T) : undefined;
    },
    close: async () => {
      try {
        await closeFile();
      } finally {
        for (const { directory } of directories) await directory.close().catch(() => undefined);
        directories.length = 0;
        db.close();
      }
    },
  };
}
