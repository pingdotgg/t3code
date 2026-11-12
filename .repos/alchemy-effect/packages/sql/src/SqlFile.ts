import crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface SqlFile {
  id: string;
  sql: string;
  hash: string;
}

/**
 * Recursively list `.sql` files under `directory`, sorted by their numeric
 * prefix (e.g. `0001_init.sql`) and then by name.
 */
export const listSqlFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(directory, { recursive: true });

    const sqlFiles = entries
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => {
        const aNum = getPrefix(a);
        const bNum = getPrefix(b);
        if (aNum !== null && bNum !== null) return aNum - bNum;
        if (aNum !== null) return -1;
        if (bNum !== null) return 1;
        return a.localeCompare(b);
      });

    return yield* Effect.forEach(sqlFiles, (id) => readSqlFile(directory, id));
  });

/**
 * Read a single `.sql` file relative to `directory` and compute its content
 * hash. The `sql` field is marked non-enumerable so it isn't serialized into
 * resource state.
 */
export const readSqlFile = (directory: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* fs.readFileString(path.resolve(directory, name));
    const hash = crypto.createHash("sha256").update(sql).digest("hex");
    const file: SqlFile = { id: name, sql, hash };
    Object.defineProperty(file, "sql", { enumerable: false });
    return file;
  });

export const hashMigrations = (migrationsDir: string) =>
  listSqlFiles(migrationsDir).pipe(
    Effect.map((files) => {
      const hashes: Record<string, string> = {};
      for (const file of files) hashes[file.id] = file.hash;
      return hashes;
    }),
  );

/**
 * Apply `importFiles` (paths relative to `rootDir`): each file runs through
 * `apply` once, and again only when its contents change. `previous` is the
 * `importHashes` a prior deploy persisted; the result is the new
 * `importHashes`, covering exactly the files still listed.
 */
export const applySqlImports = <E, R>(options: {
  importFiles: ReadonlyArray<string> | undefined;
  rootDir: string;
  previous: Record<string, string> | undefined;
  apply: (file: SqlFile) => Effect.Effect<void, E, R>;
}) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = {};
    for (const filePath of options.importFiles ?? []) {
      const file = yield* readSqlFile(options.rootDir, filePath);
      if (options.previous?.[filePath] !== file.hash) {
        yield* options.apply(file);
      }
      hashes[filePath] = file.hash;
    }
    return hashes;
  });

export const hashImports = (importFiles: ReadonlyArray<string>, rootDir: string) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = {};
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      hashes[filePath] = file.hash;
    }
    return hashes;
  });

const getPrefix = (name: string): number | null => {
  const prefix = name.split("_")[0];
  const num = Number.parseInt(prefix, 10);
  return Number.isNaN(num) ? null : num;
};

// Drizzle (and other migration tools) emit `--> statement-breakpoint` between
// statements. drizzle-kit puts the marker directly after single-line
// statements (`...;--> statement-breakpoint`), so the split can't anchor on a
// preceding newline.
const STATEMENT_BREAKPOINT = /\s*-->\s*statement-breakpoint\s*/g;

/**
 * Split a migration file into individual statements on its
 * `--> statement-breakpoint` markers. MySQL engines need this: they only
 * treat `--` as a comment when followed by whitespace, so the `-->` token is
 * a syntax error ("syntax error at position 2" on Vitess). Postgres and
 * sqlite comment on `--` regardless of the next character, so their runners
 * send files whole.
 */
export const splitSqlStatements = (sql: string): string[] =>
  sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

type SqliteToken = "semi" | "ws" | "other" | "explain" | "create" | "temp" | "trigger" | "end";
type SqliteState =
  | "invalid"
  | "start"
  | "normal"
  | "explain"
  | "create"
  | "trigger"
  | "semi"
  | "end";

// SQLite's `sqlite3_complete` state machine: a `;` ends a statement unless
// it sits inside a `CREATE [TEMP] TRIGGER ... BEGIN ... END` body.
const SQLITE_TRANSITIONS: Record<SqliteState, Record<SqliteToken, SqliteState>> = {
  invalid: {
    semi: "start",
    ws: "invalid",
    other: "normal",
    explain: "explain",
    create: "create",
    temp: "normal",
    trigger: "normal",
    end: "normal",
  },
  start: {
    semi: "start",
    ws: "start",
    other: "normal",
    explain: "explain",
    create: "create",
    temp: "normal",
    trigger: "normal",
    end: "normal",
  },
  normal: {
    semi: "start",
    ws: "normal",
    other: "normal",
    explain: "normal",
    create: "normal",
    temp: "normal",
    trigger: "normal",
    end: "normal",
  },
  explain: {
    semi: "start",
    ws: "explain",
    other: "explain",
    explain: "normal",
    create: "create",
    temp: "normal",
    trigger: "normal",
    end: "normal",
  },
  create: {
    semi: "start",
    ws: "create",
    other: "normal",
    explain: "normal",
    create: "normal",
    temp: "create",
    trigger: "trigger",
    end: "normal",
  },
  trigger: {
    semi: "semi",
    ws: "trigger",
    other: "trigger",
    explain: "trigger",
    create: "trigger",
    temp: "trigger",
    trigger: "trigger",
    end: "trigger",
  },
  semi: {
    semi: "semi",
    ws: "semi",
    other: "trigger",
    explain: "trigger",
    create: "trigger",
    temp: "trigger",
    trigger: "trigger",
    end: "end",
  },
  end: {
    semi: "start",
    ws: "end",
    other: "trigger",
    explain: "trigger",
    create: "trigger",
    temp: "trigger",
    trigger: "trigger",
    end: "trigger",
  },
};

const SQLITE_IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

const classifySqliteIdentifier = (identifier: string): SqliteToken => {
  switch (identifier.toLowerCase()) {
    case "explain":
      return "explain";
    case "create":
      return "create";
    case "temp":
    case "temporary":
      return "temp";
    case "trigger":
      return "trigger";
    case "end":
      return "end";
    default:
      return "other";
  }
};

/**
 * Split a SQLite script into its statements, without their terminating `;`.
 * Semicolons inside quoted strings, identifiers (`"…"`, `` `…` ``, `[…]`),
 * comments, and trigger bodies don't split. Comments before a statement stay
 * with it, and comment-only segments are dropped. Matches how
 * `wrangler d1 execute --file` splits a file.
 */
export const splitSqliteStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let start = 0;
  let state: SqliteState = "invalid";
  let hasContent = false;
  const flush = (end: number) => {
    const statement = sql.slice(start, end).trim();
    if (hasContent && statement.length > 0) statements.push(statement);
  };
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    let token: SqliteToken;
    if (char === ";") {
      token = "semi";
    } else if (/\s/.test(char)) {
      token = "ws";
    } else if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
      token = "ws";
    } else if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end === -1 ? sql.length : end;
      token = "ws";
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = sql.indexOf(char === "[" ? "]" : char, index + 1);
      index = end === -1 ? sql.length : end;
      token = "other";
    } else if (SQLITE_IDENTIFIER_CHAR.test(char)) {
      const identifierStart = index;
      while (index + 1 < sql.length && SQLITE_IDENTIFIER_CHAR.test(sql[index + 1])) index++;
      token = classifySqliteIdentifier(sql.slice(identifierStart, index + 1));
    } else {
      token = "other";
    }
    hasContent ||= token !== "semi" && token !== "ws";
    state = SQLITE_TRANSITIONS[state][token];
    if (token === "semi" && state === "start") {
      flush(index);
      start = index + 1;
      hasContent = false;
    }
  }
  flush(sql.length);
  return statements;
};
