const BARE_KEY = /[A-Za-z0-9_-]+/uy;
const KEY_ESCAPE = /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|[^])/gu;
const ASSIGNMENT = /[ \t]*=/uy;
// Where an unclosed string or array was meant to end is a guess, so any line that could assign
// the key counts.
const SQLITE_HOME_LINE = /^[ \t]*["']?sqlite_home["']?[ \t]*=/mu;

const BASIC_STRING = /^"((?:[^"\\\n]|\\.)*)"[ \t]*(?:#.*)?$/u;
const LITERAL_STRING = /^'([^'\n]*)'[ \t]*(?:#.*)?$/u;

/** The single-line TOML string that makes up all of `value`, or undefined for anything else. */
export const tomlStringValue = (value: string): string | undefined => {
  const literal = LITERAL_STRING.exec(value);
  if (literal) return literal[1];
  const basic = BASIC_STRING.exec(value);
  if (!basic) return undefined;
  try {
    // TOML's basic-string escapes are JSON's, plus `\U` and `\e`, which this leaves unread.
    return JSON.parse(`"${basic[1]}"`) as string;
  } catch {
    return undefined;
  }
};

const unescapeKey = (key: string) =>
  key.replace(KEY_ESCAPE, (escape, ...hex: Array<string | undefined>) => {
    const code = Number.parseInt(hex[0] ?? hex[1] ?? hex[2] ?? "", 16);
    // Only an ASCII escape can spell part of the key.
    return code < 0x80 ? String.fromCharCode(code) : escape;
  });

/**
 * The `sqlite_home` a Codex config.toml sets, with `value` undefined when it is not a single-line
 * string, or undefined when it sets none. Codex reads it from the root table only, so a
 * table's key of that name, such as an MCP server's environment variable, and the text of a
 * string or a comment are not the setting.
 */
export const codexConfigSqliteHome = (
  config: string,
): { readonly value: string | undefined } | undefined => {
  let unclosed = false;

  /** The index after the string that opens at `start`. */
  const stringEnd = (start: number) => {
    const quote = config[start] ?? "";
    const closing = config.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
    for (let index = start + closing.length; index < config.length; index++) {
      const char = config[index];
      if (char === "\n" && closing.length === 1) break;
      if (char === "\\" && quote === '"' && config[index + 1] !== "\n") index++;
      else if (config.startsWith(closing, index)) {
        index += closing.length;
        // A multi-line string may end in up to two quotes of its own.
        for (let extra = 0; closing.length === 3 && extra < 2 && config[index] === quote; extra++) {
          index++;
        }
        return index;
      }
    }
    unclosed = true;
    return config.length;
  };

  let index = 0;
  while (index < config.length) {
    const char = config[index] ?? "";
    // `\s` covers the byte order mark a Windows editor may write.
    if (/\s/u.test(char)) {
      index++;
      continue;
    }
    // Nothing after the first table header belongs to the root table.
    if (char === "[") break;
    if (char !== "#") {
      let key: string | undefined;
      if (char === '"' || char === "'") {
        const end = stringEnd(index);
        key = config.slice(index + 1, end - 1);
        if (char === '"') key = unescapeKey(key);
        index = end;
      } else {
        BARE_KEY.lastIndex = index;
        key = BARE_KEY.exec(config)?.[0];
        index += key?.length ?? 0;
      }
      ASSIGNMENT.lastIndex = index;
      // `sqlite_home.x` is a table, which Codex does not read as a path.
      if (key === "sqlite_home" && ASSIGNMENT.test(config)) {
        const lineEnd = config.indexOf("\n", ASSIGNMENT.lastIndex);
        const value = config.slice(ASSIGNMENT.lastIndex, lineEnd < 0 ? undefined : lineEnd);
        return { value: tomlStringValue(value.trim()) };
      }
    }
    // A value ends at the first newline outside its strings, arrays and inline tables.
    let depth = 0;
    for (; index < config.length; index++) {
      const valueChar = config[index];
      if (valueChar === "\n" && depth <= 0) break;
      if (valueChar === "#") {
        const lineEnd = config.indexOf("\n", index);
        index = (lineEnd < 0 ? config.length : lineEnd) - 1;
      } else if (valueChar === '"' || valueChar === "'") index = stringEnd(index) - 1;
      else if (valueChar === "[" || valueChar === "{") depth++;
      else if (valueChar === "]" || valueChar === "}") depth--;
    }
    if (depth > 0) unclosed = true;
  }
  return unclosed && SQLITE_HOME_LINE.test(config) ? { value: undefined } : undefined;
};
