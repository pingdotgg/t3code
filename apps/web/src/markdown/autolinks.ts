// GFM autolink literals, both halves of how remark finds them: micromark's tokenizer while
// parsing (links with positions), then mdast-util-gfm-autolink-literal's pass over the decoded
// text outside links (links without positions).
import type { Link, Nodes, Parent, PhrasingContent, Text } from "mdast";

const isAsciiAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAsciiAlphanumeric = (c: number) => isAsciiAlpha(c) || (c >= 48 && c <= 57);
const isAsciiControl = (c: number) => c < 32 || c === 127;
const isLineEndingOrSpace = (c: number) => c === 9 || c === 10 || c === 13 || c === 32;
const UNICODE_WHITESPACE = /\s/u;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;
const isUnicodeWhitespace = (c: number) =>
  c === 9 || c === 10 || c === 12 || c === 13 || c === 32 || (c > 127 && UNICODE_WHITESPACE.test(String.fromCharCode(c)));
const isUnicodePunctuation = (c: number) =>
  c >= 0 &&
  ((c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126) ||
    (c > 127 && UNICODE_PUNCTUATION.test(String.fromCharCode(c))));

export const isGfmAtext = (c: number) =>
  c === 43 || c === 45 || c === 46 || c === 95 || isAsciiAlphanumeric(c);

/** micromark's previous-character checks; -1 is the start of the text. */
export const previousWww = (c: number) =>
  c === -1 || c === 40 || c === 42 || c === 95 || c === 91 || c === 93 || c === 126 || isLineEndingOrSpace(c);
export const previousProtocol = (c: number) => !isAsciiAlpha(c);
export const previousEmail = (c: number) => !(c === 47 || isGfmAtext(c));

const code = (s: string, at: number) => (at < s.length ? s.charCodeAt(at) : -1);

/** tokenizeTrail: whether the punctuation run at `at` ends the link (`ok`). */
function trailOk(s: string, at: number): boolean {
  let i = at;
  while (true) {
    const c = code(s, i);
    if (c === 33 || c === 34 || c === 39 || c === 41 || c === 42 || c === 44 || c === 46 || c === 58 || c === 59 || c === 63 || c === 95 || c === 126) {
      i++;
      continue;
    }
    if (c === 38) {
      i++;
      if (!isAsciiAlpha(code(s, i))) return false;
      while (isAsciiAlpha(code(s, i))) i++;
      if (code(s, i) !== 59) return false;
      i++;
      continue;
    }
    if (c === 93) {
      i++;
      const n = code(s, i);
      if (n === -1 || n === 40 || n === 91 || isLineEndingOrSpace(n) || isUnicodeWhitespace(n)) return true;
      continue;
    }
    return c === 60 || c === -1 || isLineEndingOrSpace(c) || isUnicodeWhitespace(c);
  }
}

/** tokenizeDomain: end of the domain at `at`, or -1. */
function scanDomain(s: string, at: number): number {
  let underscoreInLast = false;
  let underscoreInLastLast = false;
  let seen = false;
  let i = at;
  while (true) {
    const c = code(s, i);
    if (c === 46 || c === 95) {
      if (trailOk(s, i)) break;
      if (c === 95) underscoreInLast = true;
      else {
        underscoreInLastLast = underscoreInLast;
        underscoreInLast = false;
      }
      i++;
      continue;
    }
    if (c === -1 || isLineEndingOrSpace(c) || isUnicodeWhitespace(c) || (c !== 45 && isUnicodePunctuation(c))) break;
    seen = true;
    i++;
  }
  if (underscoreInLastLast || underscoreInLast || !seen) return -1;
  return i;
}

/** tokenizePath: end of the path at `at` (always succeeds). */
function scanPath(s: string, at: number): number {
  let open = 0;
  let close = 0;
  let i = at;
  while (true) {
    const c = code(s, i);
    if (c === 40) {
      open++;
      i++;
      continue;
    }
    if (c === 41 && close < open) {
      close++;
      i++;
      continue;
    }
    if (c === 33 || c === 34 || c === 38 || c === 39 || c === 41 || c === 42 || c === 44 || c === 46 || c === 58 || c === 59 || c === 60 || c === 63 || c === 93 || c === 95 || c === 126) {
      if (trailOk(s, i)) return i;
      if (c === 41) close++;
      i++;
      continue;
    }
    if (c === -1 || isLineEndingOrSpace(c) || isUnicodeWhitespace(c)) return i;
    i++;
  }
}

/** A www autolink starting at `at`: its end, or -1. */
export function matchWww(s: string, at: number): number {
  for (let k = 0; k < 3; k++) if ((code(s, at + k) | 32) !== 119) return -1;
  if (code(s, at + 3) !== 46 || at + 4 >= s.length) return -1;
  const domainEnd = scanDomain(s, at);
  if (domainEnd < 0) return -1;
  return scanPath(s, domainEnd);
}

/** An http(s) autolink starting at `at`: its end, or -1. */
export function matchProtocol(s: string, at: number): number {
  let i = at;
  let protocol = "";
  while (isAsciiAlpha(code(s, i)) && protocol.length < 5) {
    protocol += s[i];
    i++;
  }
  protocol = protocol.toLowerCase();
  if (code(s, i) !== 58 || (protocol !== "http" && protocol !== "https")) return -1;
  if (code(s, i + 1) !== 47 || code(s, i + 2) !== 47) return -1;
  i += 3;
  const c = code(s, i);
  if (c === -1 || isAsciiControl(c) || isLineEndingOrSpace(c) || isUnicodeWhitespace(c) || isUnicodePunctuation(c)) return -1;
  const domainEnd = scanDomain(s, i);
  if (domainEnd < 0) return -1;
  return scanPath(s, domainEnd);
}

/** An email autolink starting at `at`: its end, or -1. */
export function matchEmail(s: string, at: number): number {
  let i = at;
  if (!isGfmAtext(code(s, i))) return -1;
  while (isGfmAtext(code(s, i))) i++;
  if (code(s, i) !== 64) return -1;
  i++;
  let data = false;
  let dot = false;
  while (true) {
    const c = code(s, i);
    if (c === 46) {
      // A dot followed by a non-alphanumeric ends the domain.
      if (!isAsciiAlphanumeric(code(s, i + 1))) break;
      dot = true;
      i++;
      continue;
    }
    if (c === 45 || c === 95 || isAsciiAlphanumeric(c)) {
      data = true;
      i++;
      continue;
    }
    break;
  }
  return data && dot && isAsciiAlpha(code(s, i - 1)) ? i : -1;
}

// --- The mdast pass over decoded text --------------------------------------------------------

const URL_PATTERN = /(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi;
const EMAIL_PATTERN = /(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu;
const AUTOLINK_TEXT = /@|https?:\/\/|www\./i;

function previousOk(input: string, index: number, email: boolean): boolean {
  const c = input.charCodeAt(index - 1);
  return (index === 0 || isUnicodeWhitespace(c) || isUnicodePunctuation(c)) && (!email || c !== 47);
}

function isCorrectDomain(domain: string): boolean {
  const parts = domain.split(".");
  const last = parts[parts.length - 1];
  const lastLast = parts[parts.length - 2];
  return !(
    parts.length < 2 ||
    (last && (/_/.test(last) || !/[a-zA-Z\d]/.test(last))) ||
    (lastLast && (/_/.test(lastLast) || !/[a-zA-Z\d]/.test(lastLast)))
  );
}

function splitUrl(value: string): [string, string | undefined] {
  const trailExec = /[!"&'),.:;<>?\]}]+$/.exec(value);
  if (!trailExec) return [value, undefined];
  let url = value.slice(0, trailExec.index);
  let trail = trailExec[0];
  let closingParenIndex = trail.indexOf(")");
  const openingParens = url.split("(").length - 1;
  let closingParens = url.split(")").length - 1;
  while (closingParenIndex !== -1 && openingParens > closingParens) {
    url += trail.slice(0, closingParenIndex + 1);
    trail = trail.slice(closingParenIndex + 1);
    closingParenIndex = trail.indexOf(")");
    closingParens++;
  }
  return [url, trail];
}

type Replace = (match: RegExpExecArray) => PhrasingContent | PhrasingContent[] | false;

const findUrl: Replace = (match) => {
  let [, protocol = "", domain = "", path = ""] = match;
  let prefix = "";
  if (!previousOk(match.input, match.index, false)) return false;
  if (/^w/i.test(protocol)) {
    domain = protocol + domain;
    protocol = "";
    prefix = "http://";
  }
  if (!isCorrectDomain(domain)) return false;
  const parts = splitUrl(domain + path);
  if (!parts[0]) return false;
  const link: Link = {
    type: "link",
    title: null,
    url: prefix + protocol + parts[0],
    children: [{ type: "text", value: protocol + parts[0] }],
  };
  return parts[1] ? [link, { type: "text", value: parts[1] }] : link;
};

const findEmail: Replace = (match) => {
  const [, atext = "", label = ""] = match;
  if (!previousOk(match.input, match.index, true) || /[-\d_]$/.test(label)) return false;
  return {
    type: "link",
    title: null,
    url: `mailto:${atext}@${label}`,
    children: [{ type: "text", value: `${atext}@${label}` }],
  };
};

function replaceIn(parent: Parent, pattern: RegExp, replace: Replace) {
  const children = parent.children as Nodes[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type === "link" || child.type === "linkReference") continue;
    if (child.type !== "text") {
      if ("children" in child) replaceIn(child as Parent, pattern, replace);
      continue;
    }
    const value = (child as Text).value;
    const nodes: PhrasingContent[] = [];
    let start = 0;
    let changed = false;
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      const position = match.index;
      const result = replace(match);
      if (result === false) {
        pattern.lastIndex = position + 1;
      } else {
        if (start !== position) nodes.push({ type: "text", value: value.slice(start, position) });
        if (Array.isArray(result)) nodes.push(...result);
        else nodes.push(result);
        start = position + match[0].length;
        changed = true;
      }
      match = pattern.exec(value);
    }
    if (!changed) continue;
    if (start < value.length) nodes.push({ type: "text", value: value.slice(start) });
    children.splice(index, 1, ...(nodes as Nodes[]));
    index += nodes.length - 1;
  }
}

function hasAutolinkText(node: Nodes): boolean {
  if (node.type === "text") return AUTOLINK_TEXT.test(node.value);
  if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return false;
  return (node.children as Nodes[]).some(hasAutolinkText);
}

/** mdast-util-gfm-autolink-literal's transform, skipped when no text could match. */
export function transformAutolinkLiterals(tree: Parent) {
  if (!hasAutolinkText(tree as Nodes)) return;
  replaceIn(tree, URL_PATTERN, findUrl);
  replaceIn(tree, EMAIL_PATTERN, findEmail);
}
