import { isMap, isScalar, parseDocument } from "yaml";

const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;

const FRONTMATTER_BLOCK =
  /^(\uFEFF?---[ \t]*)(\r\n|\r|\n)([\s\S]*?)(\r\n|\r|\n)?((?:---|\.\.\.)[ \t]*)(\r\n|\r|\n|$)/;

/**
 * Blanks a leading YAML frontmatter block so rendered previews skip it instead
 * of showing a rule and a setext heading. Masked characters become spaces and
 * line breaks stay, so source offsets (task checkbox edits) stay valid.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, (block) => block.replace(/[^\r\n]/g, " "));
}

export function readTaskFrontmatter(markdown: string) {
  const match = FRONTMATTER_BLOCK.exec(markdown);
  if (!match) return { title: null, state: null, pinned: false };
  const document = parseDocument((match[3] ?? "").replace(/\r(?!\n)/g, "\n"), { uniqueKeys: true });
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents)))
    return null;
  const get = (key: string): unknown => {
    if (!document.contents || !isMap(document.contents)) return undefined;
    const pair = document.contents.items.find(
      (item) => isScalar(item.key) && item.key.value === key,
    );
    if (!pair) return undefined;
    if (pair.value === null) return null;
    return isScalar(pair.value) ? pair.value.value : undefined;
  };
  const title = get("title");
  const state = get("state");
  return {
    title: typeof title === "string" ? title : null,
    state: typeof state === "string" ? state : null,
    pinned: get("pinned") === true,
  };
}

/** Patches only task-owned scalar values, leaving comments and other frontmatter fields intact. */
export function patchTaskFrontmatter(
  markdown: string,
  values: { readonly title: string; readonly state: string; readonly pinned: boolean },
): string | null {
  if (!values.title.trim()) return null;
  const match = FRONTMATTER_BLOCK.exec(markdown);
  const eol =
    match?.[2] ?? (markdown.includes("\r\n") ? "\r\n" : markdown.includes("\r") ? "\r" : "\n");
  const fields = [
    ["title", JSON.stringify(values.title.trim())],
    ["state", values.state ? JSON.stringify(values.state) : ""],
    ["pinned", String(values.pinned)],
  ] as const;

  if (!match) {
    const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom ? markdown.slice(1) : markdown;
    const frontmatter = fields.map(([key, value]) => (value ? `${key}: ${value}` : `${key}:`));
    return `${bom}---${eol}${frontmatter.join(eol)}${eol}---${body ? eol : ""}${body}`;
  }

  const [, opening, openingEol, frontmatter, separator, closing, closingTerminator] = match;
  const original = frontmatter ?? "";
  const document = parseDocument(original.replace(/\r(?!\n)/g, "\n"), { uniqueKeys: true });
  if (document.errors.length > 0) return null;
  const root = document.contents;
  if (root !== null && !isMap(root)) return null;

  const edits: Array<{ start: number; end: number; value: string }> = [];
  const additions: string[] = [];
  for (const [key, value] of fields) {
    const pair =
      root && isMap(root)
        ? root.items.find((item) => isScalar(item.key) && item.key.value === key)
        : undefined;
    if (!pair) {
      additions.push(value ? `${key}: ${value}` : `${key}:`);
      continue;
    }
    if (isScalar(pair.value) && pair.value.value === null) {
      if (value === "") continue;
      if (pair.value.range === null) return null;
      const [start, end] = pair.value.range;
      const whitespace = /\s$/.test(original.slice(0, start))
        ? ""
        : original.slice(start, end).match(/^\s*/)?.[0] || " ";
      const separator = original.slice(end).startsWith("#") ? " " : "";
      edits.push({ start, end, value: `${whitespace}${value}${separator}` });
      continue;
    }
    if (pair.value === null) {
      if (value === "") continue;
      if (!isScalar(pair.key) || pair.key.range === null) return null;
      const colon = original.indexOf(":", pair.key.range[1]);
      if (colon < 0) return null;
      edits.push({ start: colon + 1, end: colon + 1, value: ` ${value}` });
      continue;
    }
    if (!isScalar(pair.value) || pair.value.range === null) return null;
    const [start, end] = pair.value.range;
    edits.push({ start, end, value });
  }

  if (additions.length > 0 && root && isMap(root) && root.flow) return null;

  let patched = original;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    patched = `${patched.slice(0, edit.start)}${edit.value}${patched.slice(edit.end)}`;
  if (additions.length > 0)
    patched = patched
      ? `${patched}${openingEol}${additions.join(openingEol)}`
      : additions.join(openingEol);

  const suffix = markdown.slice(match[0].length);
  const closingEol = separator ?? (patched ? openingEol : "");
  return `${opening}${openingEol}${patched}${closingEol}${closing}${closingTerminator}${suffix}`;
}
