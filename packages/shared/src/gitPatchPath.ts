/**
 * How a file's name travels in a unified patch, which is not as itself.
 *
 * A patch's headers are lines with the name inside them, and the reader finds the name by where
 * it stops: `diff --git a/<old> b/<new>` splits on a space, `--- a/<name>` stops at a tab. So a
 * name holding a tab or a newline reads back as the part of itself before that byte, or fabricates
 * a header line of its own. Git's answer is to write such a name quoted, with C-style escapes, and
 * every reader of the format knows the form.
 *
 * Both halves live together so that what one writes is what the other reads.
 */

/**
 * What git escapes by name, as the character written and the escape written for it.
 *
 * Not every byte git would escape: it also escapes anything outside ASCII when `core.quotePath` is
 * on, which is a setting for what a terminal can show rather than anything the format needs. A
 * patch here is read by a diff viewer, so a name in another alphabet is left as itself and arrives
 * legible.
 */
const ESCAPE_BY_CHARACTER = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\u0007", "\\a"],
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\v", "\\v"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);

/** The escape written for a character, as the byte it stands for. */
const CHARACTER_BY_ESCAPE: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

const QUOTE = '"';
const DELETE_CHARACTER = 0x7f;
const LOWEST_PRINTABLE = 0x20;
const BACKSLASH = 0x5c;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * A name as a patch header can carry it: itself where that is unambiguous, and git's quoted form
 * where it is not. The name a reader of the header gets back is the name that went in.
 *
 * A quote or a backslash is what the quoting is written with, and a control character either stops
 * the reader short or starts a line the patch never had, so a name holding any of them is quoted.
 *
 * A header side's `a/` or `b/` belongs inside the quoting, so pass it in along with the name: what
 * git quotes is the whole token a reader takes off the line, side letter and all.
 */
export function quoteGitPatchPath(path: string): string {
  let body = "";
  let quoting = false;
  for (const character of path) {
    const escape = ESCAPE_BY_CHARACTER.get(character);
    if (escape !== undefined) {
      body += escape;
      quoting = true;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    // Every character git has no name for is written as the octal of its byte, and a control
    // character is one byte in UTF-8, so the character's own code point is that byte.
    if (code < LOWEST_PRINTABLE || code === DELETE_CHARACTER) {
      body += `\\${code.toString(8).padStart(3, "0")}`;
      quoting = true;
      continue;
    }
    body += character;
  }
  return quoting ? `${QUOTE}${body}${QUOTE}` : path;
}

/**
 * The escapes inside a quoted form undone, whether or not the quotes are still around them.
 *
 * A name holding no backslash at all is already itself and is handed straight back, which is what
 * keeps an unquoted name out of this: git quotes any name with a backslash in it, so a name that
 * arrived unquoted has no escape to undo. An escape git would never write reads the way C reads
 * it, as the character behind the backslash.
 *
 * The escapes are per byte, so a name in any other alphabet arrives as a run of octal and only
 * reads back as itself once those bytes are rejoined and decoded together.
 */
function unescapeBody(body: string): string {
  if (!body.includes("\\")) return body;
  const bytes: Array<number> = [];
  // Anything left as itself is encoded a run at a time rather than a unit at a time, so a
  // character outside the basic plane keeps its pair together rather than coming back as halves.
  let literal = "";
  const flush = () => {
    if (literal.length === 0) return;
    bytes.push(...utf8.encode(literal));
    literal = "";
  };
  let at = 0;
  while (at < body.length) {
    const character = body.charAt(at);
    if (character !== "\\") {
      literal += character;
      at += 1;
      continue;
    }
    const escaped = body.charAt(at + 1);
    if (escaped === "") {
      flush();
      bytes.push(BACKSLASH);
      break;
    }
    const named = CHARACTER_BY_ESCAPE[escaped];
    if (named !== undefined) {
      flush();
      bytes.push(named);
      at += 2;
      continue;
    }
    const octal = body.slice(at + 1, at + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      flush();
      bytes.push(Number.parseInt(octal, 8));
      at += 4;
      continue;
    }
    literal += escaped;
    at += 2;
  }
  flush();
  return fromUtf8.decode(new Uint8Array(bytes));
}

/**
 * One header's name token as the name it stands for.
 *
 * The quoting comes off where it is there, and the escapes are undone either way: patch parsers
 * disagree about how much of the quoting they hand back, and the one the clients read diffs with
 * takes the quotes off the `diff --git` line's names and leaves them on a rename's. A name a
 * producer wrote unquoted never carries an escape to undo, so reading it for them costs it
 * nothing.
 */
export function unquoteGitPatchPath(token: string): string {
  if (token.length >= 2 && token.startsWith(QUOTE) && token.endsWith(QUOTE)) {
    return unescapeBody(token.slice(1, -1));
  }
  return unescapeBody(token);
}
