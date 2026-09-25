import * as Schema from "effect/Schema";

const decodeString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));

/** A lossless structural reader: edits only binding nodes, never reformats a user's KDL. */
type Token = { value: string; start: number; end: number; quoted: boolean };
export type KdlNode = {
  name: string;
  header: Token[];
  children: KdlNode[];
  start: number;
  end: number;
  close: number | undefined;
};

export function readKdlNodes(source: string): KdlNode[] {
  const tokens: Token[] = [];
  let offset = 0;
  const invalid = () =>
    new Error("Couldn't read this Niri config. Use Advanced to configure it manually.");
  while (offset < source.length) {
    const start = offset;
    const rest = source.slice(offset);
    if (/^[\t \r\uFEFF\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/.test(rest)) {
      offset++;
      continue;
    }
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", offset);
      offset = end < 0 ? source.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      offset += 2;
      let depth = 1;
      while (depth && offset < source.length) {
        if (source.startsWith("/*", offset)) {
          depth++;
          offset += 2;
        } else if (source.startsWith("*/", offset)) {
          depth--;
          offset += 2;
        } else offset++;
      }
      if (depth) throw invalid();
      continue;
    }
    const continuation = /^\\[\t \r\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*\n/.exec(rest);
    if (continuation) {
      offset += continuation[0].length;
      continue;
    }
    const raw = /^r(#{0,32})"/.exec(rest);
    if (raw) {
      const terminator = `"${raw[1]}`;
      const end = source.indexOf(terminator, offset + raw[0].length);
      if (end < 0) throw invalid();
      offset = end + terminator.length;
      tokens.push({
        value: source.slice(start + raw[0].length, end),
        start,
        end: offset,
        quoted: true,
      });
      continue;
    }
    if (rest[0] === '"') {
      offset++;
      while (offset < source.length && source[offset] !== '"') {
        if (source[offset] === "\\") offset++;
        offset++;
      }
      if (offset === source.length) throw invalid();
      offset++;
      // KDL's unicode escapes differ from JSON; names needing those stay on the manual path.
      let value: string;
      try {
        value = decodeString(source.slice(start, offset));
      } catch {
        throw invalid();
      }
      tokens.push({ value, start, end: offset, quoted: true });
      continue;
    }
    if (rest.startsWith("/-")) offset += 2;
    else if ("{};\n=()".includes(rest[0]!)) offset++;
    else {
      while (offset < source.length && !/[\s{};="()]/.test(source[offset]!)) {
        if (["//", "/*", "/-"].some((prefix) => source.startsWith(prefix, offset))) break;
        offset++;
      }
    }
    if (offset === start) throw invalid();
    tokens.push({ value: source.slice(start, offset), start, end: offset, quoted: false });
  }
  let cursor = 0;
  const is = (token: Token | undefined, value: string) =>
    token && !token.quoted && token.value === value;
  const nodes = (nested: boolean): KdlNode[] => {
    const result: KdlNode[] = [];
    while (cursor < tokens.length) {
      if (is(tokens[cursor], "\n") || is(tokens[cursor], ";")) {
        cursor++;
        continue;
      }
      if (is(tokens[cursor], "}")) {
        if (!nested) throw invalid();
        return result;
      }
      const disabled = is(tokens[cursor], "/-");
      if (disabled) cursor++;
      const name = tokens[cursor++];
      if (!name || ["{", "}", "=", ";", "\n", "("].includes(name.value)) throw invalid();
      const node: KdlNode = {
        name: name.value,
        header: [name],
        children: [],
        start: name.start,
        end: name.end,
        close: undefined,
      };
      while (
        cursor < tokens.length &&
        !is(tokens[cursor], "\n") &&
        !is(tokens[cursor], ";") &&
        !is(tokens[cursor], "}")
      ) {
        const token = tokens[cursor++]!;
        if (is(token, "{")) {
          node.children = nodes(true);
          const close = tokens[cursor++];
          if (!is(close, "}")) throw invalid();
          node.close = close!.start;
          node.end = close!.end;
          break;
        }
        node.header.push(token);
        node.end = token.end;
      }
      if (!disabled) result.push(node);
    }
    if (nested) throw invalid();
    return result;
  };
  return nodes(false);
}
