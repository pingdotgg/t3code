/**
 * Host-side secret scrubbing for agent log tails, applied before contents
 * cross the `t3.orchestration/logs` contract. Deliberately over-redacts: a
 * false positive costs a log line, a miss leaks a credential.
 *
 * The scanner reads the text as JSON-ish lines. Every string holding an escape
 * is decoded (`\"`, `\\`, `\n`, `\uXXXX`, …) and scanned again as its own
 * text, so a transcript record quoting a tool result that quotes JSON is read
 * at each depth with escapes interpreted in their own string, never across
 * one. A redaction found in decoded text replaces the exact source span of the
 * characters it covers, re-escaped for that string. Each depth scans at most
 * the text of the one above it and depth is capped, so work stays linear.
 * Private-key markers are the exception: they are read once, in the whole
 * text decoded through every depth (`findKeys`), so a key opened in one
 * string stays open across later strings and lines.
 *
 * Raw line structure survives: a redaction at the top level that spans lines
 * keeps one marker per line, so `maxLines` counting still holds.
 */
export const LOG_REDACTED = "[REDACTED]";
const R = LOG_REDACTED;

/**
 * Where a text begins in its source. By default it may begin inside a JSON
 * string, and outside any private key. `lineStart` says it begins a line;
 * `key` whether that is inside a key (its BEGIN line came earlier, with the
 * type `inside` names), or may be.
 */
export interface LogTextStart {
  readonly lineStart?: boolean;
  readonly key?: KeyStart;
}
export type KeyStart = "outside" | "unknown" | { readonly inside: string };

/** Strings nested deeper than this are redacted whole instead of decoded. */
const MAX_DEPTH = 12;

/**
 * A region to replace: rendered from its `kind` (`value` becomes the marker,
 * `json` a quoted marker, `lines` a key block) or carrying its `text`.
 */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind?: "value" | "json" | "lines";
  readonly text?: string;
}

/** Characters inspected by the current scan; see `measureLogRedaction`. */
let visits = 0;

/**
 * Whether a field or variable name carries a secret. The name is normalized
 * by splitting camelCase words with `_`, lowercasing, and reading `-`, `.`,
 * and spaces as `_`, so `apiKey`, `API_KEY`, `api-key`, and `api.key` all
 * read `api_key`. A keyword must not run on into more letters: `token` and
 * `GH_TOKEN_SCOPE` match, `input_tokens`, `tokenizer`, and `author` do not.
 */
const SECRET_NAME =
  /(?:api_?key|secret|token|passw(?:or)?d|passphrase|credentials?|private_?key|access_?key|auth(?:orization)?|cookie|session)(?![a-z])/;
const isSecretName = (name: string) => {
  visits += name.length;
  return SECRET_NAME.test(
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[-. ]/g, "_"),
  );
};

const isSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\r";
const isBase64 = (char: string | undefined) =>
  char !== undefined &&
  ((char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    (char >= "0" && char <= "9") ||
    char === "+" ||
    char === "/" ||
    char === "=");

/**
 * The containers open around a secret member's own object, read from the
 * text before it: `open[0, depth)`, outermost first. `known` when the text's
 * start opened none, so nothing may close past them. `null` when the member
 * sits where no object can hold it.
 */
interface Enclosing {
  readonly open: readonly string[];
  readonly depth: number;
  readonly known: boolean;
}

/** Set by `stringEnd`: whether the contents it passed hold an escape. */
let escaped = false;
/**
 * End of a JSON string's contents starting at `from`: its closing quote, or
 * the line break or end of text that cuts it off. A quote followed by
 * anything but JSON punctuation cannot close a well-formed string, so it is
 * read as contents, keeping the rest of a mis-escaped value inside it. A
 * secret value, given its `enclosing` containers, fails closed further: only
 * a quote after which the line validly continues as JSON closes it
 * (`continuesJson`).
 */
function stringEnd(text: string, from: number, enclosing?: Enclosing | null): number {
  escaped = false;
  const strict = enclosing !== undefined;
  let at = from;
  while (at < text.length) {
    visits++;
    const char = text[at];
    if (char === "\n") return at;
    if (char === '"') {
      if (!strict ? closesString(text, at + 1) : closes.has(at)) return at;
      if (enclosing) {
        const verdict = continuesJson(text, at + 1, enclosing);
        if (verdict) return at;
        // Out of budget: the rest of the line stays in the value.
        if (verdict === null) return skip(text, at, (next) => next !== "\n");
      }
      at++;
    } else if (char === "\\" && text[at + 1] !== "\n") {
      escaped = true;
      at += 2;
    } else at++;
  }
  return text.length;
}

/** Whether the text from `at`, just after a quote, can follow a JSON string. */
function closesString(text: string, at: number): boolean {
  const char = text[skip(text, at, isSpace)];
  return (
    char === undefined ||
    char === "\n" ||
    char === "," ||
    char === ":" ||
    char === "}" ||
    char === "]"
  );
}

/**
 * Quotes known to close a secret value: a successful `continuesJson` run
 * records every member value it read, so later values on its line need no
 * run of their own. Reset with `budget` for each text.
 */
const closes = new Set<number>();
/** Steps `continuesJson` may still take in the current text. */
let budget = 0;
const LITERAL_AT = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
const STRING_ESCAPE = /["\\/bfnrt]/;
/**
 * Where a JSON string whose contents start at `at` ends (after its closing
 * quote): -1 if it is invalid or broken by a line, past the text if cut off.
 */
function jsonStringEnd(text: string, at: number): number {
  while (at < text.length) {
    visits++;
    budget--;
    const char = text[at];
    if (char === '"') return at + 1;
    if (char === "\n") return -1;
    if (char !== "\\") at++;
    else if (at + 1 >= text.length) break;
    else if (STRING_ESCAPE.test(text[at + 1]!)) at += 2;
    else if (text[at + 1] !== "u") return -1;
    else if (at + 6 > text.length) break;
    else if (HEX4.test(text.slice(at + 2, at + 6))) at += 6;
    else return -1;
  }
  return text.length + 1;
}
/**
 * Whether the text from `at`, just after a quote that would end a secret
 * member's value, continues as JSON to the end of its line or text. A stack
 * follows the containers: the value's own object, then the `enclosing` ones,
 * then, only past a start that may be inside containers, ones whose kind is
 * unseen (`?`) until an element or a closing bracket shows it. Past a known
 * start nothing more may follow. Names and strings are unbounded. `null` when
 * the text's `budget` runs out.
 */
function continuesJson(text: string, at: number, enclosing: Enclosing): boolean | null {
  const stack = ["{"];
  let depth = enclosing.depth;
  const values: number[] = [];
  // The next token: what follows a value, a value, a member name, or either
  // of the last two in a container of unseen kind. `open` just after a bracket.
  let want: "after" | "value" | "name" | "element" = "after";
  let open = false;
  for (;;) {
    at = skip(text, at, isSpace);
    if (--budget < 0) return null;
    visits++;
    const char = text[at];
    if (char === undefined || char === "\n") {
      for (const value of values) closes.add(value);
      return true;
    }
    const top = stack.length - 1;
    if ((want === "after" || open) && (char === "}" || char === "]")) {
      if (top < 0 || (stack[top] !== "?" && stack[top] !== (char === "}" ? "{" : "[")))
        return false;
      stack.pop();
      if (stack.length === 0) {
        if (depth > 0) stack.push(enclosing.open[--depth]!);
        else if (!enclosing.known) stack.push("?");
      }
      want = "after";
      open = false;
      at++;
      continue;
    }
    open = false;
    if (want === "after") {
      if (char !== "," || top < 0) return false;
      want = stack[top] === "{" ? "name" : stack[top] === "[" ? "value" : "element";
      at++;
      continue;
    }
    if (char === '"') {
      const end = jsonStringEnd(text, at + 1);
      if (end === -1) return false;
      if (end > text.length) return true;
      if (want === "value") {
        if (stack[top] === "{") values.push(end - 1);
        want = "after";
        at = end;
        continue;
      }
      const next = skip(text, end, isSpace);
      if (text[next] === ":") {
        if (want === "element") stack[top] = "{";
        want = "value";
        at = next + 1;
        continue;
      }
      if (want === "name") return next === text.length;
      stack[top] = "[";
      want = "after";
      at = end;
      continue;
    }
    if (want === "name") return false;
    if (want === "element") stack[top] = "[";
    if (char === "{" || char === "[") {
      stack.push(char);
      want = char === "{" ? "name" : "value";
      open = true;
      at++;
      continue;
    }
    LITERAL_AT.lastIndex = at;
    if (!LITERAL_AT.test(text)) return false;
    visits += LITERAL_AT.lastIndex - at;
    budget -= LITERAL_AT.lastIndex - at;
    at = LITERAL_AT.lastIndex;
    const next = text[at];
    if (!(next === undefined || isSpace(next) || next === "\n" || ",}]".includes(next)))
      return false;
    want = "after";
  }
}

const ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HEX4 = /^[0-9A-Fa-f]{4}$/;
/**
 * Decodes string contents `text[start, end)`. `offsets[i]` is where decoded
 * character `i` starts in `text`, and `offsets[length]` is `end`, so a decoded
 * span `[a, b)` covers `text[offsets[a], offsets[b])`. An escape cut off by
 * the end of the contents decodes to nothing and stays inside the last span.
 */
function decode(text: string, start: number, end: number) {
  let decoded = "";
  const offsets: number[] = [];
  let run = start;
  let at = start;
  const flush = (to: number) => {
    decoded += text.slice(run, to);
    for (let index = run; index < to; index++) offsets.push(index);
  };
  while (at < end) {
    visits++;
    if (text[at] !== "\\") {
      at++;
      continue;
    }
    flush(at);
    run = end;
    if (at + 1 >= end) break;
    const next = text[at + 1]!;
    let char = ESCAPES[next] ?? next;
    let width = 2;
    if (next === "u") {
      if (at + 6 > end) break;
      const hex = text.slice(at + 2, at + 6);
      if (HEX4.test(hex)) {
        char = String.fromCharCode(Number.parseInt(hex, 16));
        width = 6;
      }
    }
    decoded += char;
    offsets.push(at);
    at += width;
    run = at;
  }
  flush(end);
  offsets.push(end);
  return { decoded, offsets };
}

/** First index from `at` whose character fails `test`. */
function skip(text: string, at: number, test: (char: string | undefined) => boolean) {
  while (at < text.length && test(text[at])) {
    at++;
    visits++;
  }
  return at;
}
/** Lowest index down to `floor` such that every character from it to `at` passes `test`. */
function skipBack(
  text: string,
  at: number,
  floor: number,
  test: (char: string | undefined) => boolean,
) {
  while (at > floor && test(text[at - 1])) {
    at--;
    visits++;
  }
  return at;
}

const MARKER = /-----(BEGIN|END)([A-Z0-9 ]{0,40})PRIVATE KEY-----/g;
/** A marker's key type (`RSA`, `OPENSSH`, empty for a bare key): END closes only its own. */
const keyType = (words: string) => words.trim().replace(/ +/g, " ");
/**
 * A possible BEGIN left encoded when decoding is exhausted: a dash run beside
 * an escape, or a BEGIN marker any of whose characters is an escape (a
 * backslash, any further escaped backslashes, then the escaped character). It
 * opens a key of type `UNKNOWN_KEY`, which no END closes.
 */
const ENCODED = String.raw`\\(?:u005[cC]|\\)*(?:u[0-9A-Fa-f]{4}|[^\n\\])`;
const either = (chars: string) => [...chars].map((char) => `(?:${char}|${ENCODED})`).join("");
const MAYBE_MARKER = new RegExp(
  String.raw`-----\\|\\(?:u[0-9A-Fa-f]{4}|[^\n])-----|` +
    `${either("-----BEGIN")}(?:[A-Z0-9 ]|${ENCODED}){0,40}${either("PRIVATE KEY-----")}`,
  "g",
);
const UNKNOWN_KEY = "?";

/**
 * `text` with its escapes decoded again and again, so a marker escaped at
 * any depth (`\\n`, `\u0042`) reads plainly, and `at(i)`, where its character
 * `i` starts in `text`. Decoding stops after `MAX_DEPTH + 1` passes; escapes
 * left then are `exhausted`.
 */
function normalize(text: string) {
  let plain = text;
  let offsets: number[] | null = null;
  for (let pass = 0; pass <= MAX_DEPTH && plain.includes("\\"); pass++) {
    visits += plain.length;
    const next = decode(plain, 0, plain.length);
    const outer: number[] | null = offsets;
    offsets = outer ? next.offsets.map((index) => outer[index]!) : next.offsets;
    plain = next.decoded;
  }
  visits += plain.length;
  const map = offsets;
  return {
    plain,
    exhausted: plain.includes("\\"),
    at: (index: number) => (map ? map[index]! : index),
  };
}

/**
 * Start of the key material above an END marker at `marker` whose BEGIN line
 * is not in the text, or -1. The marker must start its line, after spaces or
 * directly after base64, so prose that mentions it keeps its line. Walks back
 * over base64, spaces, and line breaks, never below `floor`; `keyAbove` says
 * key material already redacted ends at `floor`.
 */
function tailStart(text: string, marker: number, floor: number, keyAbove: boolean): number {
  let start = marker;
  start = skipBack(text, start, floor, isSpace);
  if (start === marker) start = skipBack(text, start, floor, isBase64);
  if (start !== 0 && text[start - 1] !== "\n") return -1;
  let key = false;
  for (let at = start; at < marker && !key; at++) {
    visits++;
    key = isBase64(text[at]);
  }
  while (start > floor) {
    const char = text[start - 1];
    if (isBase64(char)) key = true;
    else if (!isSpace(char) && char !== "\n") break;
    start--;
    visits++;
  }
  return key || (keyAbove && start === floor) ? start : -1;
}

const KEY_HEADER_AT = /[ \t]*(?:Proc-Type|DEK-Info):/y;
/**
 * End of the leading lines that could be key material (base64, spaces, blank
 * lines, PEM headers) in a text that begins at a line whose key state is
 * unknown. They are withheld whatever their width; the first other line ends
 * them.
 */
function keyLinesEnd(text: string): number {
  let end = 0;
  for (let at = 0; at < text.length;) {
    let stop = skip(text, at, (char) => isBase64(char) || isSpace(char));
    if (stop < text.length && text[stop] !== "\n") {
      KEY_HEADER_AT.lastIndex = at;
      if (!KEY_HEADER_AT.test(text)) break;
      stop = skip(text, stop, (char) => char !== "\n");
    }
    end = stop;
    at = stop + 1;
  }
  return end;
}

/**
 * PEM private keys, read in the normalized text so a marker counts in any
 * form (its own line, after a word, inside a string, escaped at any depth).
 * A BEGIN opens a key that runs through the next END of its own type, or to
 * the end of the text: prose that merely mentions a marker loses the rest of
 * its text rather than risk a key. Also tails whose BEGIN is gone, and the
 * lines opening a text that begins inside a key (through its END) or may
 * (`keyLinesEnd`). Where decoding is exhausted, a possible marker left
 * encoded (`MAYBE_MARKER`) opens a key of unknown type through the end of the
 * text. Returns the key state at the end of the text.
 */
function findKeys(text: string, spans: Span[], key: KeyStart): KeyStart {
  const { plain, exhausted, at } = normalize(text);
  const push = (start: number, end: number) =>
    spans.push({ start: at(start), end: at(end), kind: "lines" });
  /** End of the first END of `type` from `from`, or -1. */
  const endOf = (type: string, from: number) => {
    MARKER.lastIndex = from;
    for (let match = MARKER.exec(plain); match; match = MARKER.exec(plain))
      if (match[1] === "END" && keyType(match[2]!) === type) return MARKER.lastIndex;
    return -1;
  };
  let state = key;
  let floor = 0;
  if (typeof key === "object") {
    const end = endOf(key.inside, 0);
    if (end === -1) floor = plain.length;
    else [floor, state] = [end, "outside"];
  } else if (key === "unknown") floor = keyLinesEnd(plain);
  const keyFloor = floor;
  if (floor > 0) push(0, floor);
  /** Where a possible marker left encoded opens a key from `from`, or -1. */
  const maybeFrom = (from: number) => {
    if (!exhausted) return -1;
    MAYBE_MARKER.lastIndex = from;
    return MAYBE_MARKER.exec(plain)?.index ?? -1;
  };
  let maybe = maybeFrom(floor);
  MARKER.lastIndex = floor;
  for (let match = MARKER.exec(plain); ; match = MARKER.exec(plain)) {
    if (maybe !== -1 && maybe < floor) maybe = maybeFrom(floor);
    if (maybe !== -1 && (!match || maybe < match.index)) {
      push(maybe, plain.length);
      return { inside: UNKNOWN_KEY };
    }
    if (!match) break;
    const markerEnd = match.index + match[0].length;
    if (match[1] === "BEGIN") {
      const type = keyType(match[2]!);
      const end = endOf(type, markerEnd);
      push(match.index, end === -1 ? plain.length : end);
      if (end === -1) return { inside: type };
      state = "outside";
      floor = MARKER.lastIndex = end;
      continue;
    }
    const start = tailStart(plain, match.index, floor, floor > 0 && floor === keyFloor);
    if (start !== -1) push(start, markerEnd);
    state = "outside";
    floor = markerEnd;
  }
  return state;
}

/** The private-key state at the end of `text`, which begins in state `start`. */
export const keyStateAfter = (text: string, start: KeyStart): KeyStart => findKeys(text, [], start);

/**
 * A quoted name, then JSON whitespace, a colon, and more whitespace. The
 * name may hold escapes; a quote after a backslash is escaped and never
 * opens one.
 */
const FIELD = /(?<!\\)"((?:[^"\\\n]|\\[^\n]){1,128})"[ \t\r\n]*:[ \t\r\n]*/g;

/**
 * The complete JSON value (string, number, literal, array, object) at `at`,
 * a secret member's value inside `enclosing` containers.
 */
function valueSpan(text: string, at: number, enclosing: Enclosing | null): Span {
  const char = text[at];
  if (char === '"')
    return { start: at + 1, end: stringEnd(text, at + 1, enclosing), kind: "value" };
  if (char === "{" || char === "[") {
    let depth = 0;
    for (let stop = at; stop < text.length;) {
      visits++;
      const next = text[stop]!;
      if (next === '"') {
        stop = stringEnd(text, stop + 1);
        if (text[stop] === '"') stop++;
        continue;
      }
      if (next === "{" || next === "[") depth++;
      else if ((next === "}" || next === "]") && --depth === 0)
        return { start: at, end: stop + 1, kind: "json" };
      stop++;
    }
    return { start: at, end: text.length, kind: "json" };
  }
  const end = skip(text, at, (char) => !/[\s,}\]"\\]/.test(char!));
  return { start: at, end, kind: "json" };
}

/**
 * JSON fields with a secret-bearing name: the whole value. The containers
 * open before each are followed from the text's start, across lines; where
 * the text may begin inside a string (`unknownStart`) its first line cannot
 * be read, and the containers before it are unknown.
 */
function findFields(text: string, spans: Span[], unknownStart: boolean) {
  visits += text.length;
  closes.clear();
  budget = 4 * text.length + 256;
  const open: string[] = [];
  const firstLine = unknownStart ? skip(text, 0, (char) => char !== "\n") : 0;
  let read = firstLine;
  /** The containers open at `to`, a member name's quote, or null if `to` is inside a string. */
  const enclosingAt = (to: number): Enclosing | null => {
    if (to < firstLine) return { open: [], depth: 0, known: false };
    while (read < to) {
      visits++;
      const char = text[read];
      if (char === '"') {
        const end = stringEnd(text, read + 1);
        read = text[end] === '"' ? end + 1 : end;
        continue;
      }
      if (char === "{" || char === "[") open.push(char);
      else if (char === "}" || char === "]") open.pop();
      read++;
    }
    if (read > to) return null;
    const top = open.at(-1);
    if (top === undefined) return unknownStart ? { open, depth: 0, known: false } : null;
    return top === "{" ? { open, depth: open.length - 1, known: !unknownStart } : null;
  };
  FIELD.lastIndex = 0;
  for (let match = FIELD.exec(text); match; match = FIELD.exec(text)) {
    const name = match[1]!;
    if (!isSecretName(name.includes("\\") ? decode(name, 0, name.length).decoded : name)) continue;
    const span = valueSpan(text, match.index + match[0].length, enclosingAt(match.index));
    spans.push(span);
    FIELD.lastIndex = Math.max(FIELD.lastIndex, span.end);
  }
}

/** Line-local shapes, each yielding the span of the secret in a match. */
const RULES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => Span | null]> = [
  // Assignments and flags: OPENAI_API_KEY=…, export GH_TOKEN="…", --password=….
  [
    /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,128})[ \t]*=[ \t]*("(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|[^\s"'\\,;&|)]+)/g,
    (match) => {
      if (!isSecretName(match[1]!)) return null;
      const value = match[2]!;
      const end = match.index + match[0].length;
      const quote = value[0] === '"' || value[0] === "'" ? 1 : 0;
      const closed = quote && value.length > 1 && value.endsWith(value[0]!) ? 1 : 0;
      return { start: end - value.length + quote, end: end - closed, kind: "value" };
    },
  ],
  // Authorization-style headers, keeping the scheme.
  [
    /(?<![A-Za-z0-9-])(?:(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|(?:set-)?cookie)[ \t]*:[ \t]*"?(?:(?:bearer|basic|token|bot|digest)[ \t]+)?([^\n"\\]+)/gi,
    (match) => tail(match, match[1]!),
  ],
  // Bearer credentials and well-known token shapes anywhere.
  [/\bBearer[ \t]+([A-Za-z0-9._~+/=-]{8,})/g, (match) => tail(match, match[1]!)],
  [
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    (match) => tail(match, match[0]),
  ],
  // Credentials embedded in URLs: scheme://user:pass@host. Anchored on the
  // `://` delimiter rather than the scheme, so a long run of scheme-like
  // words is not rescanned from every word boundary.
  [
    /(?<=[a-z0-9+.-]):\/\/([^/\s:@"'\\]+:[^/\s@"'\\]+)@/gi,
    (match) => ({ start: match.index + 3, end: match.index + match[0].length - 1, kind: "value" }),
  ],
];
/** The span of `part`, which ends `match`. */
const tail = (match: RegExpExecArray, part: string): Span => {
  const end = match.index + match[0].length;
  return { start: end - part.length, end, kind: "value" };
};

const perLine = (text: string) =>
  text
    .split("\n")
    .map((line) => (line.trim() ? R : line))
    .join("\n");

function render(text: string, depth: number, span: Span): string {
  if (span.text !== undefined) return span.text;
  const lines = depth === 0 && text.slice(span.start, span.end).includes("\n");
  if (span.kind === "lines" || lines)
    return depth === 0 ? perLine(text.slice(span.start, span.end)) : R;
  return span.kind === "json" ? `"${R}"` : R;
}

/**
 * Redactions for `text` at `depth`, as sorted, disjoint replacements in its
 * own coordinates. `unknownStart` marks text that may begin inside a string
 * (an arbitrary cut, or a string whose opening quote is gone); `key` is
 * whether it begins inside a private key.
 */
function redactText(text: string, depth: number, unknownStart: boolean, key: KeyStart): Span[] {
  const spans: Span[] = [];
  // Keys are found once, at the top, in text decoded through every depth.
  if (depth === 0) findKeys(text, spans, key);
  else if (key === "unknown") spans.push({ start: 0, end: keyLinesEnd(text), kind: "lines" });
  findFields(text, spans, unknownStart);
  for (const [pattern, toSpan] of RULES) {
    visits += text.length;
    for (const match of text.matchAll(pattern)) {
      const span = toSpan(match);
      if (span) spans.push(span);
    }
  }
  const nested = (start: number, end: number, unknown: boolean) => {
    if (end <= start) return;
    if (depth >= MAX_DEPTH) return void spans.push({ start, end, text: R });
    const { decoded, offsets } = decode(text, start, end);
    for (const span of redactText(decoded, depth + 1, unknown, unknown ? "unknown" : "outside"))
      spans.push({
        start: offsets[span.start]!,
        end: offsets[span.end]!,
        text: JSON.stringify(span.text).slice(1, -1),
      });
  };
  // Strings with escapes are scanned again, decoded. `open` is where a string
  // would have opened if the last quote closing one was really an opening
  // quote: an escaped quote (`\"` or `\u0022`) outside any string shows the
  // pairing is off by one, so the string is re-read from there. Where the
  // start is unknown, an escape before the first quote means the text began
  // inside a string.
  let at = 0;
  let open = 0;
  if (unknownStart) {
    const end = stringEnd(text, 0);
    if (escaped) {
      nested(0, end, true);
      open = at = text[end] === '"' ? end + 1 : end;
    }
  }
  while (at < text.length) {
    visits++;
    const char = text[at];
    if (char === "\n") open = ++at;
    else if (
      char === '"' ||
      (char === "\\" && (text[at + 1] === '"' || text.startsWith("u0022", at + 1)))
    ) {
      const from = char === '"' ? at + 1 : open;
      const end = stringEnd(text, from);
      if (escaped) nested(from, end, false);
      open = at = text[end] === '"' ? end + 1 : end;
    } else at++;
  }
  // Overlapping spans merge; one containing the rest keeps its rendering.
  const sorted = spans
    .filter((span) => span.end > span.start)
    .toSorted((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (let index = 0; index < sorted.length;) {
    const first = sorted[index]!;
    let end = first.end;
    for (index++; index < sorted.length && sorted[index]!.start < end; index++)
      end = Math.max(end, sorted[index]!.end);
    const span = end === first.end ? first : { start: first.start, end, kind: "lines" as const };
    merged.push({ start: span.start, end, text: render(text, depth, span) });
  }
  return merged;
}

/** `redactLogSecrets`, also reporting the characters the scan inspected. */
export function measureLogRedaction(
  text: string,
  start: LogTextStart = {},
): {
  readonly text: string;
  readonly visits: number;
} {
  visits = 0;
  let result = "";
  let at = 0;
  for (const span of redactText(text, 0, !start.lineStart, start.key ?? "outside")) {
    result += text.slice(at, span.start) + span.text;
    at = span.end;
  }
  return { text: result + text.slice(at), visits };
}

export function redactLogSecrets(text: string, start: LogTextStart = {}): string {
  return measureLogRedaction(text, start).text;
}
