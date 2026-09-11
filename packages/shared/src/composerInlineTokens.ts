export type ComposerInlineToken =
  | {
      readonly type: "mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: "skill";
      readonly value: string;
      readonly path?: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    };

export interface CollectComposerInlineTokensOptions {
  readonly preserveTrailingFrom?: ReadonlyArray<ComposerInlineToken>;
}

export function serializeSkillReference(skill: { name: string; path: string }): string {
  const path = encodeURI(skill.path).replace(
    /[()?#]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[$${skill.name}](${path})`;
}

/** Explicit source references survive draft storage and transport as Markdown. */
export function collectSkillReferences(
  text: string,
): ReadonlyArray<{ name: string; path: string }> {
  const references = new Map<string, { name: string; path: string }>();
  for (const token of collectSkillReferenceTokens(text)) {
    if (token.path)
      references.set(JSON.stringify([token.value, token.path]), {
        name: token.value,
        path: token.path,
      });
  }
  return [...references.values()];
}

/** Markdown fences and exact-length backtick spans are literal, including unclosed fences. */
function collectMarkdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const fences: Array<{ start: number; end: number }> = [];
  let open: { start: number; character: string; length: number } | undefined;
  for (const line of text.matchAll(/^.*(?:\n|$)/gm)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)\r?\n?$/.exec(line[0]);
    if (!delimiter) continue;
    const run = delimiter[1]!;
    const rest = delimiter[2]!;
    if (open) {
      if (run[0] === open.character && run.length >= open.length && rest.trim() === "") {
        fences.push({ start: open.start, end: line.index + line[0].length });
        open = undefined;
      }
    } else if (run[0] !== "`" || !rest.includes("`")) {
      open = { start: line.index, character: run[0]!, length: run.length };
    }
  }
  if (open) fences.push({ start: open.start, end: text.length });
  const ranges = [...fences];
  let offset = 0;
  for (const fence of [...fences, { start: text.length, end: text.length }]) {
    const runs = [...text.slice(offset, fence.start).matchAll(/`+/g)].map((run) => {
      const start = offset + run.index;
      let backslashes = 0;
      for (let cursor = start - 1; cursor >= offset && text[cursor] === "\\"; cursor--) {
        backslashes++;
      }
      return { start, length: run[0].length, escaped: backslashes % 2 };
    });
    const nextByLength = new Map<number, number>();
    const closing = new Map<number, number>();
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index]!;
      // Outside a span, an escape consumes only the first backtick in a run.
      // Inside a span, backslashes are literal, so closing runs keep their full length.
      const next = nextByLength.get(run.length - run.escaped);
      if (next !== undefined) closing.set(index, next);
      nextByLength.set(run.length, index);
    }
    for (let index = 0; index < runs.length; index++) {
      const end = closing.get(index);
      if (end === undefined) continue;
      ranges.push({
        start: runs[index]!.start + runs[index]!.escaped,
        end: runs[end]!.start + runs[end]!.length,
      });
      index = end;
    }
    offset = fence.end;
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function collectSkillReferenceTokens(
  text: string,
): Extract<ComposerInlineToken, { type: "skill" }>[] {
  if (!text.includes("[$")) return [];
  const tokens: Extract<ComposerInlineToken, { type: "skill" }>[] = [];
  const codeRanges = collectMarkdownCodeRanges(text);
  let codeRangeIndex = 0;
  const pattern = /(^|\s)\[\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)\]\(([^\s)]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    while (codeRanges[codeRangeIndex] && codeRanges[codeRangeIndex]!.end <= start) codeRangeIndex++;
    const codeRange = codeRanges[codeRangeIndex];
    if (codeRange && start >= codeRange.start && start < codeRange.end) continue;
    const name = match[2];
    const encodedPath = match[3];
    if (!name || !encodedPath) continue;
    let path: string;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      continue;
    }
    if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path) || !/[\\/]SKILL\.md$/i.test(path)) continue;
    const end = (match.index ?? 0) + match[0].length;
    tokens.push({ type: "skill", value: name, path, source: text.slice(start, end), start, end });
  }
  return tokens;
}

/**
 * A skill name may start with a digit, but compact monetary amounts and
 * numeric expressions like "$20", "$20k", "$100M", and "$1e6" must stay prose:
 * the composer chips any matched `$name` token, known or not. Tokens beginning
 * with digits must not match numbers with currency/exponent suffixes, and must
 * contain at least one letter.
 */
const SKILL_TOKEN_REGEX =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s)/g;
const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
/**
 * The label body is bounded rather than `*`. Unbounded, every whitespace in
 * the composer is a candidate start: the engine scans the rest of the text for
 * a closing `]`, fails, and rescans from the next whitespace — quadratic on
 * input like " [[[[[…". A cap makes each attempt constant-bounded.
 *
 * Only a basename ever survives the `label !== basename` check below, so this
 * cannot reject a link a user could meaningfully write; the longest filename
 * any common filesystem allows is 255.
 */
const MAX_FILE_LINK_LABEL_LENGTH = 512;
const FILE_LINK_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\[((?:\\\\.|[^\\]\\\\]){0,${MAX_FILE_LINK_LABEL_LENGTH}})\\]\\(([^)\\s]+)\\)(?=\\s)`,
  "g",
);
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
// Autocomplete emits canonical file links, so ambiguous bare @scope/package text stays a package.
const SCOPED_PACKAGE_REFERENCE_REGEX =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;

function collectMentionTokens(text: string): ComposerInlineToken[] {
  const matches: ComposerInlineToken[] = [];

  for (const match of text.matchAll(FILE_LINK_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    const encodedPath = match[3] ?? "";
    let path = encodedPath;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      // Preserve malformed source rather than dropping a user-authored token.
    }
    const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const basename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
    const hasExternalScheme = URI_SCHEME_REGEX.test(path) && !WINDOWS_DRIVE_PATH_REGEX.test(path);
    if (!path || hasExternalScheme || label !== basename) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const path = quotedPath !== undefined ? quotedPath.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (!path || (quotedPath === undefined && SCOPED_PACKAGE_REFERENCE_REGEX.test(path))) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  return matches;
}

export function collectComposerInlineTokens(
  text: string,
  options: CollectComposerInlineTokensOptions = {},
): ReadonlyArray<ComposerInlineToken> {
  const matches = [...collectMentionTokens(text), ...collectSkillReferenceTokens(text)];

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "skill",
      value,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const token of options.preserveTrailingFrom ?? []) {
    if (
      token.end === text.length &&
      text.slice(token.start, token.end) === token.source &&
      !matches.some(
        (match) =>
          match.type === token.type && match.start === token.start && match.end === token.end,
      )
    ) {
      matches.push(token);
    }
  }

  return [...matches].sort((left, right) => left.start - right.start);
}
