/**
 * Copy editing for hand-written markdown files (`.md`, `.mdx`).
 *
 * {@link markdownBlocks} is a Sätteri mdast plugin (Astro 7's markdown
 * processor) that tags each markdown block with its source range:
 * `data-copy="md:<file>@<start>-<end>~<version>"`, where `version` hashes the
 * text the page was rendered from. {@link markdownFiles} reads and writes
 * those ranges, following offsets from older versions through the edits it
 * has made since, so a page stays editable without reloading after each save.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CopyEditHandler } from "./index.ts";
import { CopyEditError } from "./text.ts";

export const MARKDOWN_FILE_SCHEME = "md";

/** Blocks edited as markdown, as a whole. */
const BLOCKS = new Set([
  "paragraph",
  "heading",
  "list",
  "blockquote",
  "table",
  "code",
]);
/** Containers whose children are markdown blocks (asides, JSX components). */
const CONTAINERS = new Set(["containerDirective", "mdxJsxFlowElement"]);

export interface MarkdownFilesOptions {
  /** Directory ids are relative to (usually the Vite root). */
  root: string;
  /** Files to mark. @default /\.mdx?$/ */
  include?: RegExp;
  /** Files to skip, e.g. generated pages. */
  exclude?: RegExp;
  /** `data-copy-style` preset for the blocks. */
  style?: string;
}

interface Point {
  offset?: number;
}
interface MdNode {
  type: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
  position?: { start: Point; end: Point };
}
interface MdContext {
  setProperty(node: MdNode, key: "data", value: Record<string, unknown>): void;
  wrapNode(node: MdNode, parent: MdNode): void;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * Hash of a document's text after its frontmatter. Renderers see frontmatter
 * blanked to whitespace (so offsets stay file offsets); hashing only what
 * follows it gives both sides the same version.
 */
const version = (text: string) =>
  createHash("sha1")
    .update(text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---/, "").trim())
    .digest("hex")
    .slice(0, 12);

const matches = (file: string, options: MarkdownFilesOptions) =>
  (options.include ?? /\.mdx?$/).test(file) && !options.exclude?.test(file);

/**
 * A Sätteri mdast plugin entry that marks markdown blocks for editing. Put it
 * first in `markdown.processor.options.mdastPlugins`, in dev only, so it sees
 * blocks before other plugins (asides, etc.) rewrite them.
 */
export const markdownBlocks =
  (options: MarkdownFilesOptions) =>
  ({ fileURL, source }: { fileURL: URL | undefined; source: string }) => {
    if (!fileURL || fileURL.protocol !== "file:") return undefined;
    const file = fileURLToPath(fileURL);
    const rel = toPosix(path.relative(options.root, file));
    if (rel.startsWith("..") || !matches(file, options)) return undefined;
    const v = version(source);
    return {
      name: "copy-editor-markdown-blocks",
      options: { position: true },
      before(root: MdNode, ctx: MdContext) {
        const walk = (parent: MdNode) => {
          for (const node of parent.children ?? []) {
            if (CONTAINERS.has(node.type)) {
              walk(node);
              continue;
            }
            const start = node.position?.start.offset;
            const end = node.position?.end.offset;
            if (
              !BLOCKS.has(node.type) ||
              start === undefined ||
              end === undefined
            ) {
              continue;
            }
            const attributes = {
              "data-copy": `${MARKDOWN_FILE_SCHEME}:${rel}@${start}-${end}~${v}`,
              "data-copy-format": "markdown",
              ...(options.style ? { "data-copy-style": options.style } : {}),
            };
            if (node.type === "code") {
              // Code highlighters replace the <pre>, so mark a wrapper.
              ctx.wrapNode(node, {
                type: "copyEditorBlock",
                data: { hName: "div", hProperties: attributes },
                children: [],
              });
              continue;
            }
            const data = node.data ?? {};
            ctx.setProperty(node, "data", {
              ...data,
              hProperties: {
                ...(data.hProperties as Record<string, unknown> | undefined),
                ...attributes,
              },
            });
          }
        };
        walk(root);
      },
    };
  };

const parseId = (id: string) => {
  const m = /^md:(.+)@(\d+)-(\d+)~([0-9a-f]+)$/.exec(id);
  return m
    ? { file: m[1]!, start: Number(m[2]), end: Number(m[3]), version: m[4]! }
    : undefined;
};

/** One saved edit: the `before` characters at `at` became `after` characters. */
interface Step {
  at: number;
  before: number;
  after: number;
  /** Version of the file after the edit. */
  next: string;
}

const outdated = () =>
  new CopyEditError(
    "This page is out of date with its file (it changed elsewhere). Reload and try again.",
    409,
  );

/** Reads and writes the markdown behind blocks marked by {@link markdownBlocks}. */
export const markdownFiles = (
  options: MarkdownFilesOptions,
): CopyEditHandler => {
  /** Per file, the edit saved from each version, to follow old offsets. */
  const history = new Map<string, Map<string, Step>>();

  const locate = async (id: string) => {
    const parsed = parseId(id);
    const file = parsed && path.resolve(options.root, parsed.file);
    if (
      !parsed ||
      !file ||
      !file.startsWith(path.resolve(options.root) + path.sep) ||
      !matches(file, options)
    ) {
      throw new CopyEditError(`Invalid markdown copy id: ${id}`);
    }
    const code = await fs.readFile(file, "utf8");

    let { start, end } = parsed;
    const current = version(code);
    const steps = history.get(file);
    for (let v = parsed.version; v !== current;) {
      const step = steps?.get(v);
      if (!step) throw outdated();
      if (start === step.at && end === step.at + step.before) {
        end = step.at + step.after;
      } else if (start >= step.at + step.before) {
        start += step.after - step.before;
        end += step.after - step.before;
      } else if (end > step.at) {
        throw outdated();
      }
      v = step.next;
    }
    if (end > code.length) throw outdated();
    return { rel: parsed.file, file, code, start, end, current };
  };

  return {
    async readSource(id) {
      const { code, start, end } = await locate(id);
      return code.slice(start, end);
    },

    async writeSource({ id, source, base }, context) {
      const { rel, file, code, start, end, current } = await locate(id);
      if (code.slice(start, end) !== base) {
        throw new CopyEditError(
          "This text changed since you started editing. Copy your text, reload, and try again.",
          409,
        );
      }
      const next = code.slice(0, start) + source + code.slice(end);
      if (next === code) return { file: rel, changed: false };
      await fs.writeFile(file, next);
      const steps = history.get(file) ?? new Map<string, Step>();
      steps.set(current, {
        at: start,
        before: end - start,
        after: source.length,
        next: version(next),
      });
      history.set(file, steps);
      // Lets the page's own rendering replace the preview once it's rebuilt.
      context.suppressReloads(Promise.resolve());
      return { file: rel, changed: true };
    },
  };
};
