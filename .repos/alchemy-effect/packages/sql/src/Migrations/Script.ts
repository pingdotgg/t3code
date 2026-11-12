/**
 * The dialects a SQL script can be split for. `sqlite` is split by
 * `splitSqliteStatements` (in `SqlFile.ts`), which also understands trigger
 * bodies.
 */
export type ScriptDialect = "postgres" | "mysql" | "googlesql";

/** One statement of a script, without its terminating `;`. */
export interface ScannedStatement {
  /**
   * The statement's exact source slice, comments and surrounding whitespace
   * included, so offsets into `code` index it directly.
   */
  readonly sql: string;
  /** The statement with comments removed: what to send to the database. */
  readonly text: string;
  /**
   * `sql` with comments blanked and every string, quoted identifier, and
   * dollar-quoted body masked to `_` plus spaces. Offsets match `sql`, so a
   * keyword found in `code` can be sliced out of `sql`.
   */
  readonly code: string;
  /** A comment or quoted span that never closed before the end of the script. */
  readonly unterminated?: "comment" | "quote";
}

interface Rules {
  /** `#` starts a line comment. */
  readonly hashComments: boolean;
  /** `--` is a comment only when followed by whitespace (MySQL). */
  readonly dashCommentNeedsSpace: boolean;
  /** Block comments nest (PostgreSQL). */
  readonly nestedBlockComments: boolean;
  /** `$tag$ … $tag$` bodies (PostgreSQL). */
  readonly dollarQuotes: boolean;
  /** `'''…'''` and `"""…"""` (GoogleSQL). */
  readonly tripleQuotes: boolean;
  /** Quote characters that open a string or quoted identifier. */
  readonly quotes: ReadonlyArray<string>;
  /** Backslash escapes inside every quoted span. */
  readonly backslashEscapes: boolean;
}

const RULES: Record<ScriptDialect, Rules> = {
  postgres: {
    hashComments: false,
    dashCommentNeedsSpace: false,
    nestedBlockComments: true,
    dollarQuotes: true,
    tripleQuotes: false,
    quotes: ["'", '"'],
    backslashEscapes: false,
  },
  mysql: {
    hashComments: true,
    dashCommentNeedsSpace: true,
    nestedBlockComments: false,
    dollarQuotes: false,
    tripleQuotes: false,
    quotes: ["'", '"', "`"],
    backslashEscapes: true,
  },
  googlesql: {
    hashComments: true,
    dashCommentNeedsSpace: false,
    nestedBlockComments: false,
    dollarQuotes: false,
    tripleQuotes: true,
    quotes: ["'", '"', "`"],
    backslashEscapes: true,
  },
};

/** Index just past a line comment starting at `i` (the newline is kept). */
const endOfLine = (sql: string, i: number) => {
  const end = sql.indexOf("\n", i);
  return end < 0 ? sql.length : end;
};

interface Span {
  readonly end: number;
  readonly closed: boolean;
}

/** The end of a block comment starting at `i`. */
const blockComment = (sql: string, i: number, nested: boolean): Span => {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    if (nested && sql.startsWith("/*", j)) {
      depth++;
      j += 2;
    } else if (sql.startsWith("*/", j)) {
      depth--;
      j += 2;
    } else j++;
  }
  return { end: j, closed: depth === 0 };
};

/**
 * The end of a quoted span starting at `i`. A doubled closing quote
 * escapes itself in every dialect except GoogleSQL; backslashes escape when
 * the dialect (or a PostgreSQL `E'…'` string) says so, never in a GoogleSQL
 * raw string (`r'…'`).
 */
const quoted = (
  sql: string,
  i: number,
  close: string,
  options: { backslashEscapes: boolean; doubledEscapes: boolean },
): Span => {
  let j = i + close.length;
  while (j < sql.length) {
    if (options.backslashEscapes && sql[j] === "\\") {
      j += 2;
      continue;
    }
    if (sql.startsWith(close, j)) {
      j += close.length;
      if (options.doubledEscapes && close.length === 1 && sql[j] === close) {
        j++;
        continue;
      }
      return { end: j, closed: true };
    }
    j++;
  }
  return { end: sql.length, closed: false };
};

const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/**
 * Split a SQL script into statements on top-level `;`. Semicolons inside
 * strings, quoted identifiers, dollar-quoted bodies, and comments never
 * split, and each dialect's quoting and comment rules apply. Empty
 * statements are dropped.
 *
 * This is a lexer, not a parser: it does not understand statement bodies
 * that contain their own `;` outside quotes (procedural blocks), which
 * migrations for these engines don't use.
 */
export const scanSqlScript = (
  sql: string,
  dialect: ScriptDialect,
): ReadonlyArray<ScannedStatement> => {
  const rules = RULES[dialect];
  const statements: ScannedStatement[] = [];
  let start = 0;
  let text = "";
  let code = "";
  let unterminated: ScannedStatement["unterminated"];
  const push = (end: number) => {
    if (code.trim().length > 0) {
      statements.push({
        sql: sql.slice(start, end),
        text: text.trim(),
        code,
        ...(unterminated ? { unterminated } : {}),
      });
    }
    start = end + 1;
    text = "";
    code = "";
  };
  const blank = (span: string) => span.replace(/[^\n]/g, " ");
  const mask = (span: string) => `_${" ".repeat(Math.max(0, span.length - 1))}`;

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    const dashComment =
      ch === "-" &&
      next === "-" &&
      (!rules.dashCommentNeedsSpace || i + 2 >= sql.length || /\s/.test(sql[i + 2]!));
    if (dashComment || (rules.hashComments && ch === "#")) {
      const end = endOfLine(sql, i);
      code += blank(sql.slice(i, end));
      text += " ";
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const span = blockComment(sql, i, rules.nestedBlockComments);
      if (!span.closed) unterminated = "comment";
      code += blank(sql.slice(i, span.end));
      text += " ";
      i = span.end;
      continue;
    }
    if (rules.dollarQuotes && ch === "$" && !isWordChar(sql[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) unterminated = "quote";
        const end = close < 0 ? sql.length : close + tag.length;
        code += mask(sql.slice(i, end));
        text += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (rules.quotes.includes(ch)) {
      // A prefix letter right before the quote: E'…' (PostgreSQL escapes),
      // r'…' / rb'…' (GoogleSQL raw strings).
      const prefix =
        /(?:^|[^A-Za-z0-9_])([A-Za-z]{1,2})$/
          .exec(sql.slice(Math.max(0, i - 3), i))?.[1]
          ?.toLowerCase() ?? "";
      const raw = dialect === "googlesql" && ["r", "rb", "br"].includes(prefix);
      const escaped = dialect === "postgres" && prefix === "e" && ch === "'";
      const close =
        rules.tripleQuotes && ch !== "`" && sql.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      const span = quoted(sql, i, close, {
        backslashEscapes: !raw && (rules.backslashEscapes || escaped),
        doubledEscapes: dialect !== "googlesql",
      });
      if (!span.closed) unterminated = "quote";
      code += mask(sql.slice(i, span.end));
      text += sql.slice(i, span.end);
      i = span.end;
      continue;
    }
    if (ch === ";") {
      push(i);
      i++;
      continue;
    }
    code += ch;
    text += ch;
    i++;
  }
  push(sql.length);
  return statements;
};

/** Statements of a SQL script with comments removed; see {@link scanSqlScript}. */
export const splitSqlScript = (sql: string, dialect: ScriptDialect): string[] =>
  scanSqlScript(sql, dialect).map((statement) => statement.text);
