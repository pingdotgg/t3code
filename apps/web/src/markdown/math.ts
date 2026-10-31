// The chat's math syntax: micromark-extension-llm-math with this repository's patch
// (patches/micromark-extension-llm-math@3.1.0.patch), ported state for state.

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const DOLLAR = 36;
const LPAREN = 40;
const RPAREN = 41;
const COMMA = 44;
const SLASH = 47;
const COLON = 58;
const LBRACKET = 91;
const BACKSLASH = 92;
const RBRACKET = 93;
const BACKTICK = 96;

const isLineEnding = (c: number) => c === LF || c === CR;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isPadding = (c: number) => c === SPACE || c === TAB || c === COMMA;

export interface InlineMathMatch {
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

/**
 * `$…$` or `$$…$$` starting at `start`. Money stays text: a single dollar cannot open before
 * a space or close before a digit, and padding must match on both sides.
 */
export function scanDollarMath(
  s: string,
  start: number,
  singleLine: boolean,
): InlineMathMatch | null {
  const at = (index: number) => (index < s.length ? s.charCodeAt(index) : -1);
  // A dollar right after another one is part of that run, unless the first was escaped.
  if (at(start - 1) === DOLLAR && at(start - 2) !== BACKSLASH) return null;
  let i = start;
  while (at(i) === DOLLAR) i++;
  const sizeOpen = i - start;
  const first = at(i);
  if (isLineEnding(first)) return null;
  const openWhitespace = isPadding(first);
  if (sizeOpen === 1 && openWhitespace) return null;
  let slashes = 0;
  let previousData = -1;
  let beforeData = -1;
  let inData = false;
  while (true) {
    const c = at(i);
    if (!inData) {
      if (c === -1 || c === BACKTICK || ((sizeOpen === 1 || singleLine) && isLineEnding(c))) {
        return null;
      }
      if (c === DOLLAR) {
        const charBeforeClose = at(i - 1);
        let j = i;
        while (at(j) === DOLLAR) j++;
        if (j - i === sizeOpen) {
          if (isLineEnding(charBeforeClose)) return null;
          if (isDigit(at(j))) return null;
          if (openWhitespace !== isPadding(charBeforeClose)) return null;
          return { end: j, contentStart: start + sizeOpen, contentEnd: i };
        }
        // A run of another length is content.
        i = j;
        inData = true;
        continue;
      }
      if (c === SPACE || isLineEnding(c)) {
        i++;
        continue;
      }
      inData = true;
      continue;
    }
    if (c === BACKTICK) return null;
    if (c === DOLLAR && slashes % 2 === 1) {
      slashes = 0;
      i++;
      continue;
    }
    if (c === SLASH && previousData === SLASH && beforeData === COLON) return null;
    beforeData = previousData;
    previousData = c;
    slashes = c === BACKSLASH ? slashes + 1 : 0;
    if (c === -1 || c === SPACE || c === DOLLAR || isLineEnding(c)) {
      inData = false;
      continue;
    }
    i++;
  }
}

/** `\(…\)` or `\[…\]` starting at the backslash. */
export function scanTexMath(s: string, start: number, singleLine: boolean): InlineMathMatch | null {
  const at = (index: number) => (index < s.length ? s.charCodeAt(index) : -1);
  if (at(start - 1) === BACKSLASH) return null;
  const open = at(start + 1);
  if (open !== LPAREN && open !== LBRACKET) return null;
  const close = open === LPAREN ? RPAREN : RBRACKET;
  let substantive = false;
  let i = start + 2;
  let inData = false;
  while (true) {
    const c = at(i);
    if (!inData) {
      if (c === -1 || c === BACKTICK || (singleLine && isLineEnding(c))) return null;
      if (c === BACKSLASH) {
        const next = at(i + 1);
        if (next === close) {
          if (open === LBRACKET && !substantive) return null;
          return { end: i + 2, contentStart: start + 2, contentEnd: i };
        }
        // `\\` is content; any other escape continues as content after the backslash.
        i += next === BACKSLASH ? 2 : 1;
        inData = true;
        continue;
      }
      if (c === SPACE || isLineEnding(c)) {
        i++;
        continue;
      }
      inData = true;
      continue;
    }
    if (c === BACKTICK) return null;
    if (
      c !== BACKSLASH &&
      c !== -1 &&
      c !== SPACE &&
      c !== COMMA &&
      !isLineEnding(c) &&
      !isDigit(c)
    ) {
      substantive = true;
    }
    if (c === -1 || c === SPACE || c === BACKSLASH || isLineEnding(c)) {
      inData = false;
      continue;
    }
    i++;
  }
}
