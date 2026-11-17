import * as NodeSqlite from "node:sqlite";

export interface OpenCodeSessionMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface OpenCodeSession {
  readonly providerSessionId: string;
  readonly directory: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<OpenCodeSessionMessage>;
}

type Row = Record<string, unknown>;

const MAX_SESSIONS = 5_000;
const MAX_MESSAGES_PER_SESSION = 2_000;
const MAX_MESSAGE_CHARS = 256_000;

function parseJson(value: unknown): Row | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : null;
  } catch {
    return null;
  }
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part): string[] => {
      if (part === null || typeof part !== "object") return [];
      const block = part as Row;
      if (
        block.type !== undefined &&
        block.type !== "text" &&
        block.type !== "input_text" &&
        block.type !== "output_text"
      ) return [];
      return typeof block.text === "string" && block.text.trim()
        ? [block.text.trim()]
        : [];
    })
    .join("\n");
}

function isoTime(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function modelName(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === null || typeof value !== "object") return null;
  const model = value as Row;
  const id = typeof model.id === "string" ? model.id : null;
  const provider = typeof model.providerID === "string" ? model.providerID : null;
  return id === null ? null : provider === null ? id : `${provider}/${id}`;
}

function tableNames(db: NodeSqlite.DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[])
      .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
}

function columns(db: NodeSqlite.DatabaseSync, table: string): Set<string> {
  // Table names are selected only from the fixed allowlist below.
  return new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Row[])
      .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
}

function pickColumn(available: Set<string>, ...names: string[]): string | null {
  return names.find((name) => available.has(name)) ?? null;
}

function readV2(db: NodeSqlite.DatabaseSync): OpenCodeSession[] {
  const sessionColumns = columns(db, "session_v2");
  const messageColumns = columns(db, "session_message");
  const idColumn = pickColumn(sessionColumns, "id");
  const directoryColumn = pickColumn(sessionColumns, "directory", "path");
  const createdColumn = pickColumn(sessionColumns, "time_created", "created_at");
  const updatedColumn = pickColumn(sessionColumns, "time_updated", "updated_at");
  const messageSessionColumn = pickColumn(messageColumns, "session_id", "sessionID");
  const messageDataColumn = pickColumn(messageColumns, "data");
  if (!idColumn || !directoryColumn || !createdColumn || !updatedColumn ||
      !messageSessionColumn || !messageDataColumn) return [];

  const sessions = db.prepare(
    `SELECT * FROM session_v2 ORDER BY "${updatedColumn}" DESC LIMIT ?`,
  ).all(MAX_SESSIONS) as Row[];
  const readMessages = db.prepare(
    `SELECT * FROM session_message WHERE "${messageSessionColumn}" = ? ORDER BY seq ASC LIMIT ?`,
  );
  return sessions.flatMap((session): OpenCodeSession[] => {
    if (typeof session[idColumn] !== "string" ||
        typeof session[directoryColumn] !== "string" ||
        !session[directoryColumn]) return [];
    const id = session[idColumn] as string;
    const createdAt = isoTime(session[createdColumn], new Date(0).toISOString());
    const updatedAt = isoTime(session[updatedColumn], createdAt);
    const messages = (readMessages.all(id, MAX_MESSAGES_PER_SESSION) as Row[])
      .flatMap((row): OpenCodeSessionMessage[] => {
        const data = parseJson(row[messageDataColumn]);
        if (!data) return [];
        const roleValue = data.role ?? row.type;
        if (roleValue !== "user" && roleValue !== "assistant") return [];
        const text = textFromContent(data.content ?? data.text);
        if (!text) return [];
        const timestamp = data.time !== null && typeof data.time === "object"
          ? (data.time as Row).created
          : row.time_created;
        return [{
          role: roleValue,
          text: text.slice(0, MAX_MESSAGE_CHARS),
          createdAt: isoTime(timestamp, updatedAt),
        }];
      });
    return [{
      providerSessionId: id,
      directory: session[directoryColumn] as string,
      title: typeof session.title === "string" && session.title.trim()
        ? session.title.trim()
        : "Imported OpenCode session",
      model: modelName(session.model),
      createdAt,
      updatedAt,
      messages,
    }];
  });
}

function readV1(db: NodeSqlite.DatabaseSync): OpenCodeSession[] {
  const sessionColumns = columns(db, "session");
  const messageColumns = columns(db, "message");
  const partColumns = columns(db, "part");
  const sessionIdColumn = pickColumn(sessionColumns, "id");
  const directoryColumn = pickColumn(sessionColumns, "directory", "path");
  const createdColumn = pickColumn(sessionColumns, "time_created");
  const updatedColumn = pickColumn(sessionColumns, "time_updated");
  const messageSessionColumn = pickColumn(messageColumns, "session_id", "sessionID");
  const messageIdColumn = pickColumn(messageColumns, "id");
  const messageDataColumn = pickColumn(messageColumns, "data");
  const partMessageColumn = pickColumn(partColumns, "message_id");
  const partDataColumn = pickColumn(partColumns, "data");
  if (!sessionIdColumn || !directoryColumn || !createdColumn || !updatedColumn ||
      !messageSessionColumn || !messageIdColumn || !messageDataColumn ||
      !partMessageColumn || !partDataColumn) return [];

  const sessions = db.prepare(
    `SELECT * FROM session ORDER BY "${updatedColumn}" DESC LIMIT ?`,
  ).all(MAX_SESSIONS) as Row[];
  const readMessages = db.prepare(
    `SELECT * FROM message WHERE "${messageSessionColumn}" = ? ORDER BY rowid ASC LIMIT ?`,
  );
  const readParts = db.prepare(
    `SELECT * FROM part WHERE "${partMessageColumn}" = ? ORDER BY rowid ASC`,
  );
  return sessions.flatMap((session): OpenCodeSession[] => {
    if (typeof session[sessionIdColumn] !== "string" ||
        typeof session[directoryColumn] !== "string" ||
        !session[directoryColumn]) return [];
    const id = session[sessionIdColumn] as string;
    const createdAt = isoTime(session[createdColumn], new Date(0).toISOString());
    const updatedAt = isoTime(session[updatedColumn], createdAt);
    const messages = (readMessages.all(id, MAX_MESSAGES_PER_SESSION) as Row[])
      .flatMap((row): OpenCodeSessionMessage[] => {
        const data = parseJson(row[messageDataColumn]);
        if (!data || (data.role !== "user" && data.role !== "assistant")) return [];
        const text = (readParts.all(row[messageIdColumn]) as Row[])
          .flatMap((part): string[] => {
            const partData = parseJson(part[partDataColumn]);
            return partData?.type === "text" && typeof partData.text === "string"
              ? [partData.text.trim()]
              : [];
          })
          .filter(Boolean)
          .join("\n");
        if (!text) return [];
        const time = data.time !== null && typeof data.time === "object"
          ? (data.time as Row).created
          : row.time_created;
        return [{
          role: data.role,
          text: text.slice(0, MAX_MESSAGE_CHARS),
          createdAt: isoTime(time, updatedAt),
        }];
      });
    return [{
      providerSessionId: id,
      directory: session[directoryColumn] as string,
      title: typeof session.title === "string" && session.title.trim()
        ? session.title.trim()
        : "Imported OpenCode session",
      model: modelName(session.model),
      createdAt,
      updatedAt,
      messages,
    }];
  });
}

/** Reads OpenCode's V2 session projection, falling back to the legacy V1 tables.
 *  The database is opened read-only and is never migrated or modified.
 */
export function readOpenCodeSessions(databasePath: string): ReadonlyArray<OpenCodeSession> {
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 100");
    const tables = tableNames(db);
    if (tables.has("session_v2") && tables.has("session_message")) return readV2(db);
    if (tables.has("session") && tables.has("message") && tables.has("part")) return readV1(db);
    return [];
  } finally {
    db.close();
  }
}
