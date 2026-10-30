// Renders the corpus through toJsxRuntime and through the islands renderer with the same
// component stubs, and reports documents whose DOM differs. node scripts/markdown-bench/run.mjs equivalence
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import type { Element } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { createElement, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import remarkMath from "remark-math";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";

import { renderHastWithIslands } from "../../src/components/chat/markdownIslands";
import { createMarkdownRenderer } from "../../src/components/chat/markdownRenderer";
import { rehypeHeadingIds } from "../../src/components/chat/markdownFragments";
import { rehypeTextDirection } from "../../src/components/chat/markdownTextDirection";

const dir = process.env.MD_BENCH_DIR ?? NodePath.join(process.env.HOME ?? "", "bench-work/md-bench");
const { parse, serialize } = await import(NodePath.join(dir, "candidates/node_modules/parse5/dist/index.js"));
const normalize = (html: string) => serialize(parse(`<body>${html}</body>`));

const ISLANDS = new Set(["a", "img", "pre", "details", "table", "input"]);
const stub = (tag: string) =>
  function Island({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) {
    return createElement(`x-${tag}`, props, children);
  };
const components = Object.fromEntries([...ISLANDS].map((tag) => [tag, stub(tag)]));

const renderer = createMarkdownRenderer({
  remarkPlugins: [[remarkMath, { singleDollarTextMath: true }], ...CHAT_MARKDOWN_REMARK_PLUGINS],
  rehypePlugins: [...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds, rehypeTextDirection],
  components,
  urlTransform: (url) => url,
});

let checked = 0;
let differing = 0;
for (const name of ["assistant.json", "pr-comments.json"]) {
  const corpus: Array<string> = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "corpus", name), "utf8"));
  for (const text of corpus) {
    const tree = renderer.tree(text, false);
    const expected = normalize(
      renderToStaticMarkup(
        toJsxRuntime(tree, { Fragment, jsx, jsxs, components, passKeys: true, passNode: true, ignoreInvalidStyle: true }),
      ),
    );
    const actual = normalize(
      renderToStaticMarkup(
        createElement(Fragment, null, renderHastWithIslands(tree, {
          components,
          variant: "",
          isIsland: (node: Element) => ISLANDS.has(node.tagName),
          staticElement: (node: Element) => node,
        })),
      ),
    );
    checked++;
    if (actual !== expected) {
      differing++;
      if (differing <= 5) {
        let at = 0;
        while (at < expected.length && expected[at] === actual[at]) at++;
        console.log(`--- ${name} doc differs at ${at}\nexpected: ${expected.slice(Math.max(0, at - 80), at + 120)}\nactual:   ${actual.slice(Math.max(0, at - 80), at + 120)}`);
      }
    }
  }
}
console.log(`${checked} documents, ${differing} differ`);
