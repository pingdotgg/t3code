/**
 * Codex's artifact skills cite the files they produce with a directive of their own rather than a
 * Markdown link:
 *
 *     Created :codex-file-citation{path="/Users/me/project/output/report.docx" purpose="output"}.
 *
 * Nothing in the pipeline parses it, so the whole directive renders as literal text. This rewrites
 * each one into an ordinary link node, which lands the citation on the file chip the renderer
 * already gives Markdown file links — same path resolution, same open-in-editor and preview
 * behavior, no second way to open a file.
 *
 * A directive is only rewritten when its path resolves to a file: an unresolvable path is not
 * something the chip could open, and half-streamed or malformed markup should keep reading as the
 * text it is.
 */

import { resolveMarkdownFileLinkMeta } from "./markdown-links";

const CODEX_FILE_CITATION_PATTERN = /:codex-file-citation\{([^{}\r\n]*)\}/g;
// Locates the opening quote of the `path` attribute; the value that follows is closed by scanning
// (see readCitationPath), not by this pattern.
const CITATION_PATH_ATTRIBUTE_START = /(?:^|\s)path="/;
// The directive escapes `"` inside a value as `\"`; every other backslash is a literal separator
// (`C:\repo\.env`, `\\server\share\report.docx`). A trailing `\` right before the closing quote is
// therefore byte-identical to an escaped quote, so the closer cannot be found by escape rules
// alone — only by which choice leaves a directive that parses (see readCitationPath).
const CITATION_ESCAPED_QUOTE_PATTERN = /\\"/g;
// A well-formed remainder after the path value: zero or more ` key="value"` attributes then the end.
const CITATION_ATTRIBUTE_TAIL_PATTERN = /^(?:\s+[A-Za-z_][\w-]*="(?:\\"|[^"])*")*\s*$/;
// A citation path is a filesystem path, not a URL. Percent-encoding the characters that URL
// parsing would otherwise claim — a Windows drive colon read as a scheme, `#` and `?` read as a
// fragment and a query — keeps the path intact through react-markdown's URL transform and the
// sanitizer, and `resolveMarkdownFileLinkMeta` decodes it back on the other side.
const URL_SYNTAX_CHARACTER_PATTERN = /[:#?]/g;

interface MarkdownAstNodePoint {
  readonly offset?: number;
}

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  url?: string;
  position?: { readonly start?: MarkdownAstNodePoint; readonly end?: MarkdownAstNodePoint };
  children?: MarkdownAstNode[];
}

interface MarkdownFile {
  readonly value?: unknown;
}

interface RemarkCodexFileCitationsOptions {
  readonly cwd?: string | undefined;
}

function readCitationPath(attributes: string): string | null {
  const opening = CITATION_PATH_ATTRIBUTE_START.exec(attributes);
  if (opening === null) return null;
  const valueStart = opening.index + opening[0].length;
  // `\"` (escaped quote inside the path) and a literal trailing `\` before the closer look the
  // same, so the closing quote is the first `"` after which the rest of the directive is a valid
  // attribute tail. That picks the escaped quote's outer closer in `report \" purpose=x.pdf" ...`
  // and the trailing-separator closer in `C:\dir\" purpose="x"`, each without a lookahead that the
  // other case would satisfy.
  for (let i = valueStart; i < attributes.length; i++) {
    if (attributes[i] !== '"') continue;
    if (!CITATION_ATTRIBUTE_TAIL_PATTERN.test(attributes.slice(i + 1))) continue;
    const path = attributes
      .slice(valueStart, i)
      .replace(CITATION_ESCAPED_QUOTE_PATTERN, '"')
      .trim();
    return path ? path : null;
  }
  return null;
}

/**
 * The href for a cited path, or null when the path cannot have one: `encodeURI` throws on an
 * unpaired surrogate, and a path no URL can carry is not a file the chip could open.
 */
export function codexFileCitationHref(path: string): string | null {
  try {
    return encodeURI(path).replace(URL_SYNTAX_CHARACTER_PATTERN, encodeURIComponent);
  } catch {
    return null;
  }
}

/** The cited paths, read straight from the message text, for the file-link metadata lookup. */
export function extractCodexFileCitationPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(CODEX_FILE_CITATION_PATTERN)) {
    const path = readCitationPath(match[1] ?? "");
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Markdown spends a text node's backslash escapes and character references before this plugin sees
 * it, and a citation path is neither: `C:\repo\.env` arrives as `C:\repo.env` and
 * `report&amp;notes.pdf` as `report&notes.pdf`, each of which names a different file. So the path is
 * read from the source the node was parsed from, and the parsed value only says where in the node
 * the directive sits. The two readings are paired in order, which only holds while both see the
 * same directives — when they disagree, the text stays text rather than pointing at another file.
 */
function rewriteCitations(
  value: string,
  source: string,
  cwd: string | undefined,
): MarkdownAstNode[] | null {
  const matches = [...value.matchAll(CODEX_FILE_CITATION_PATTERN)];
  const sourceMatches = [...source.matchAll(CODEX_FILE_CITATION_PATTERN)];
  if (matches.length !== sourceMatches.length) return null;

  const nodes: MarkdownAstNode[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    const path = readCitationPath(sourceMatches[index]?.[1] ?? "");
    if (!path) continue;
    const href = codexFileCitationHref(path);
    if (!href) continue;
    const fileLinkMeta = resolveMarkdownFileLinkMeta(href, cwd);
    if (!fileLinkMeta) continue;

    if (match.index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    nodes.push({
      type: "link",
      url: href,
      children: [{ type: "text", value: fileLinkMeta.basename }],
    });
    cursor = match.index + match[0].length;
  }

  if (nodes.length === 0) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

export function remarkCodexFileCitations(options: RemarkCodexFileCitationsOptions = {}) {
  return (tree: MarkdownAstNode, file: MarkdownFile) => {
    if (typeof file.value !== "string") return;
    const markdown = file.value;

    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (!node.children) return;

      // Code spans and fences are `inlineCode` and `code` nodes rather than text, so they are
      // skipped for free. A citation inside a link label is skipped deliberately: linkifying it
      // would nest an anchor inside the link's anchor.
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && typeof child.value === "string" && !childInsideLink) {
          // A text node another plugin produced has no position, and so no source to read the
          // path from; it keeps its text.
          const start = child.position?.start?.offset;
          const end = child.position?.end?.offset;
          if (start === undefined || end === undefined) return child;
          return rewriteCitations(child.value, markdown.slice(start, end), options.cwd) ?? child;
        }
        visit(child, childInsideLink);
        return child;
      });
    };

    visit(tree, false);
  };
}
