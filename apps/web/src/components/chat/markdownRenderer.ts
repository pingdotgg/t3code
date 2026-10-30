import type { Element, Nodes, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { VFile } from "vfile";

export type MarkdownUrlTransform = (url: string, key: string, node: Element) => string;

interface MarkdownRendererOptions {
  readonly remarkPlugins: PluggableList;
  readonly rehypePlugins: PluggableList;
  readonly components: Partial<Components>;
  readonly urlTransform: MarkdownUrlTransform;
}

// Elements are immutable, so a remount (a thread switch, a row scrolled back into view)
// reuses one instead of parsing again. Parsing is most of the cost of rendering markdown.
// An element and the hast it keeps hold about 20 bytes per source character, so ~10 MB.
const MAX_CACHED_CHARS = 500_000;
const rendered = new Map<string, ReactElement>();
let cachedChars = 0;
let nextRendererId = 0;

// A short block still holds a whole element tree.
const ENTRY_OVERHEAD_CHARS = 200;
const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, element: ReactElement) {
  // One huge message would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  rendered.set(key, element);
  cachedChars += entrySize(key);
  for (const oldest of rendered.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    rendered.delete(oldest);
    cachedChars -= entrySize(oldest);
  }
}

/** Renders markdown as react-markdown does, with one processor per plugin set. */
export function createMarkdownRenderer({
  remarkPlugins,
  rehypePlugins,
  components,
  urlTransform,
}: MarkdownRendererOptions) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins)
    .freeze();
  const keyPrefix = `${nextRendererId++}\u0000`;

  // Literal raw HTML that survived the rehype plugins, and URL attributes, as react-markdown treats them.
  const prepare = (node: Nodes) => {
    if (!("children" in node)) return;
    node.children.forEach((child, index) => {
      if (child.type === "raw") {
        node.children[index] = { type: "text", value: child.value };
        return;
      }
      if (child.type === "element") {
        for (const [key, tags] of Object.entries(urlAttributes)) {
          if (
            Object.hasOwn(child.properties, key) &&
            (tags === null || tags.includes(child.tagName))
          ) {
            child.properties[key] = urlTransform(String(child.properties[key] || ""), key, child);
          }
        }
      }
      prepare(child);
    });
  };

  return (text: string, cache: boolean): ReactElement => {
    const key = keyPrefix + text;
    const cached = rendered.get(key);
    if (cached !== undefined) {
      // Refresh its place in the eviction order.
      rendered.delete(key);
      rendered.set(key, cached);
      return cached;
    }
    const file = new VFile(text);
    const tree = processor.runSync(processor.parse(file), file) as Root;
    prepare(tree);
    const element = toJsxRuntime(tree, {
      Fragment,
      components,
      ignoreInvalidStyle: true,
      jsx,
      jsxs,
      passKeys: true,
      passNode: true,
    });
    if (cache) remember(key, element);
    return element;
  };
}
