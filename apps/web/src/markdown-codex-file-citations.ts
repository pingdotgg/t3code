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
// The path ends at the quote closing its attribute — the one followed by the next attribute or by
// the end of the directive. Matching lazily up to that lookahead keeps `report.docx" purpose="out`
// out of the path while still allowing a quote inside the path itself.
const CITATION_PATH_ATTRIBUTE_PATTERN = /(?:^|\s)path="(.*?)"(?=\s*$|\s+[A-Za-z_][\w-]*=)/;
// Markdown consumes a backslash before ASCII punctuation before this plugin sees the text, so a
// directive that escaped its quotes arrives unescaped. Stripping the escapes here too keeps the
// raw-source scan below reading the same path the rewritten nodes point at.
const MARKDOWN_ESCAPE_PATTERN = /\\([!-/:-@[-`{-~])/g;
// A citation path is a filesystem path, not a URL. Percent-encoding the characters that URL
// parsing would otherwise claim — a Windows drive colon read as a scheme, `#` and `?` read as a
// fragment and a query — keeps the path intact through react-markdown's URL transform and the
// sanitizer, and `resolveMarkdownFileLinkMeta` decodes it back on the other side.
const URL_SYNTAX_CHARACTER_PATTERN = /[:#?]/g;

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  url?: string;
  children?: MarkdownAstNode[];
}

interface RemarkCodexFileCitationsOptions {
  readonly cwd?: string | undefined;
}

function readCitationPath(attributes: string): string | null {
  const path = CITATION_PATH_ATTRIBUTE_PATTERN.exec(attributes)?.[1]
    ?.replace(MARKDOWN_ESCAPE_PATTERN, "$1")
    .trim();
  return path ? path : null;
}

export function codexFileCitationHref(path: string): string {
  return encodeURI(path).replace(URL_SYNTAX_CHARACTER_PATTERN, encodeURIComponent);
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

function rewriteCitations(value: string, cwd: string | undefined): MarkdownAstNode[] | null {
  const nodes: MarkdownAstNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(CODEX_FILE_CITATION_PATTERN)) {
    const path = readCitationPath(match[1] ?? "");
    if (!path) continue;
    const href = codexFileCitationHref(path);
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
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (!node.children) return;

      // Code spans and fences are `inlineCode` and `code` nodes rather than text, so they are
      // skipped for free. A citation inside a link label is skipped deliberately: linkifying it
      // would nest an anchor inside the link's anchor.
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && typeof child.value === "string" && !childInsideLink) {
          return rewriteCitations(child.value, options.cwd) ?? child;
        }
        visit(child, childInsideLink);
        return child;
      });
    };

    visit(tree, false);
  };
}
