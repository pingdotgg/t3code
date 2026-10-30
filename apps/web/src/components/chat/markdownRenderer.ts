import type { Element, Nodes, Root } from "hast";
import type { Root as MdastRoot } from "mdast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { VFile } from "vfile";

import { remarkFastParse } from "../../markdown/remarkFastParse";
import { remarkParseWithoutUnusedSyntax } from "./markdownSyntaxGates";

// VITE_T3_MARKDOWN_PARSER=remark measures against micromark and the rehype plugins.
const FAST_PARSE = import.meta.env?.VITE_T3_MARKDOWN_PARSER !== "remark";

export type MarkdownUrlTransform = (url: string, key: string, node: Element) => string;

interface MarkdownRendererOptions {
  readonly remarkPlugins: PluggableList;
  readonly rehypePlugins: PluggableList;
  /** Builds what `rehypePlugins` would, or null to run them. */
  readonly directHast?: ((tree: MdastRoot) => Root | null) | undefined;
  readonly components: Partial<Components>;
  readonly urlTransform: MarkdownUrlTransform;
}

// Elements are immutable, so a remount (a thread switch, a row scrolled back into view)
// reuses one instead of parsing again. Parsing is most of the cost of rendering markdown.
// An element and the hast it keeps hold about 20 bytes per source character, so ~10 MB.
const MAX_CACHED_CHARS = 500_000;
interface Rendered {
  readonly tree: Root;
  element?: ReactElement;
}
const rendered = new Map<string, Rendered>();
let cachedChars = 0;
let nextRendererId = 0;

// A short block still holds a whole element tree.
const ENTRY_OVERHEAD_CHARS = 200;
const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, entry: Rendered) {
  // One huge message would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  rendered.set(key, entry);
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
  directHast,
}: MarkdownRendererOptions) {
  const remark = unified()
    .use(remarkParse)
    .use(remarkParseWithoutUnusedSyntax)
    .use(FAST_PARSE ? [remarkFastParse] : [])
    .use(remarkPlugins)
    .freeze();
  const rehype = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypePlugins).freeze();
  const toHast = (file: VFile): Root => {
    const mdast = remark.runSync(remark.parse(file), file) as MdastRoot;
    return (FAST_PARSE && directHast?.(mdast)) || (rehype.runSync(mdast as never, file) as Root);
  };
  const keyPrefix = `${nextRendererId++}\u0000`;

  // Literal raw HTML that survived the rehype plugins, and URL attributes, as react-markdown treats them.
  const prepare = (node: Nodes) => {
    if (!("children" in node)) return;
    const { children } = node;
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type === "raw") {
        children[index] = { type: "text", value: child.value };
        continue;
      }
      if (child.type !== "element") continue;
      const { properties } = child;
      for (const key in properties) {
        if (!Object.hasOwn(urlAttributes, key)) continue;
        const tags = urlAttributes[key];
        if (tags === null || tags?.includes(child.tagName)) {
          properties[key] = urlTransform(String(properties[key] || ""), key, child);
        }
      }
      prepare(child);
    }
  };

  const parse = (text: string, cache: boolean): Rendered => {
    const key = keyPrefix + text;
    const cached = rendered.get(key);
    if (cached !== undefined) {
      // Refresh its place in the eviction order.
      rendered.delete(key);
      rendered.set(key, cached);
      return cached;
    }
    const file = new VFile(text);
    const tree = toHast(file);
    prepare(tree);
    const entry: Rendered = { tree };
    if (cache) remember(key, entry);
    return entry;
  };

  return {
    /** The sanitized tree; cached trees are shared, so callers must not change them. */
    tree: (text: string, cache: boolean): Root => parse(text, cache).tree,
    render: (text: string, cache: boolean): ReactElement => {
      const entry = parse(text, cache);
      return (entry.element ??= toJsxRuntime(entry.tree, {
        Fragment,
        components,
        ignoreInvalidStyle: true,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true,
      }));
    },
  };
}
