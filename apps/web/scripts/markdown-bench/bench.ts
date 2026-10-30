// Markdown micro-benchmark over real data. Corpus and candidates live outside the repo:
// node apps/web/scripts/markdown-bench/run.mjs [filter]   (MD_BENCH_DIR defaults to ~/bench-work/md-bench)
import * as NodeFs from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Root } from "hast";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { VFile } from "vfile";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";

import { rehypeHeadingIds } from "../../src/components/chat/markdownFragments";
import { remarkParseWithoutUnusedSyntax } from "../../src/components/chat/markdownSyntaxGates";
import { rehypeTextDirection } from "../../src/components/chat/markdownTextDirection";
import { splitMarkdownBlocks } from "../../src/components/chat/markdownStreamBlocks";

const dir = process.env.MD_BENCH_DIR ?? NodePath.join(process.env.HOME ?? "", "bench-work/md-bench");
const candidates = NodePath.join(dir, "candidates/node_modules");
const load = (name: string): Array<string> =>
  JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "corpus", name), "utf8"));
const w1: string = (await import(NodePath.join(process.env.HOME ?? "", "bench-work/pandacode/bench/t3-compare/workload.mjs"))).W1_TEXT;

const corpora: Record<string, Array<string>> = {
  assistant: load("assistant.json"),
  "pr-comments": load("pr-comments.json"),
  w1: [w1],
};

const remarkPlugins: PluggableList = [[remarkMath, { singleDollarTextMath: true }], ...CHAT_MARKDOWN_REMARK_PLUGINS];
const rehypePlugins: PluggableList = [...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds, rehypeTextDirection];
const processor = unified()
  .use(remarkParse)
  .use(remarkParseWithoutUnusedSyntax)
  .use(remarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypePlugins)
  .freeze();
const parseOnly = unified().use(remarkParse).use(remarkParseWithoutUnusedSyntax).use(remarkPlugins).freeze();

const t3Hast = (text: string) => {
  const file = new VFile(text);
  return processor.runSync(processor.parse(file), file) as Root;
};
const t3Element = (text: string) =>
  toJsxRuntime(t3Hast(text), { Fragment, jsx, jsxs, ignoreInvalidStyle: true, passKeys: true });

const highlightsDir = NodePath.dirname(createRequire(import.meta.resolve("@pierre/diffs")).resolve("@pierre/highlights"));
const { codeToHtml } = await import(NodePath.join(highlightsDir, "default.js"));
const { pierreDark, pierreLight } = await import(NodePath.join(highlightsDir, "themes.js"));

const md4w = await import(NodePath.join(candidates, "md4w/js/index.js"));
await md4w.init("fast");
const markdownWasm = await import(NodePath.join(candidates, "markdown-wasm/dist/markdown.node.js"));
await markdownWasm.ready;
const comrak = await import(NodePath.join(candidates, "comrak/esm/index.js"));
const md4x = await import(NodePath.join(candidates, "md4x/lib/wasm/default.mjs"));
await md4x.init();
const MarkdownIt = (await import(NodePath.join(candidates, "markdown-it/dist/markdown-it.mjs"))).default;
const markdownIt = new MarkdownIt({ html: true, linkify: true });
const { marked } = await import(NodePath.join(candidates, "marked/lib/marked.esm.js"));
const commonmark = await import(NodePath.join(candidates, "commonmark/dist/commonmark.js"));
const cmParser = new commonmark.Parser();
const cmRenderer = new commonmark.HtmlRenderer();
const { micromark } = await import(NodePath.join(candidates, "micromark/index.js"));
const { gfm, gfmHtml } = await import(NodePath.join(candidates, "micromark-extension-gfm/index.js"));
const lezer = await import(NodePath.join(candidates, "@lezer/markdown/dist/index.js"));
const lezerParser = lezer.parser.configure(lezer.GFM);

const md4wFlags = ["DEFAULT", "TABLES", "STRIKETHROUGH", "TASKLISTS", "PERMISSIVE_AUTOLINKS"];
const comrakOptions = { extension: { table: true, strikethrough: true, autolink: true, tasklist: true, footnotes: true } };

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm;
const fences = (text: string) => [...text.matchAll(FENCE)].map((m) => ({ lang: m[2]!.trim().split(/\s/)[0] || "text", code: m[3]! }));
const highlightThemes = { light: pierreLight, dark: pierreDark };
const decoder = new TextDecoder();
const highlight = (lang: string, code: string) => {
  try {
    return decoder.decode(codeToHtml(code, { lang: lang as "text", themes: highlightThemes }));
  } catch {
    return decoder.decode(codeToHtml(code, { lang: "text", themes: highlightThemes }));
  }
};

// The W1 stream as the server delivers it: 500 snapshots of the whole text so far.
const w1Snapshots = Array.from({ length: 500 }, (_, i) => w1.slice(0, Math.round(((i + 1) / 500) * w1.length)));

interface Options { readonly iterations: number; readonly warmupIterations: number }
const options: Options = { iterations: 5, warmupIterations: 2 };
const filter = process.argv[2];
let group = "";
let groupBytes = 0;
const describe = (name: string, body: () => void, bytes = 0) => {
  group = name;
  groupBytes = bytes;
  console.log(`\n## ${name}`);
  body();
};
const bench = (name: string, fn: () => void, { iterations, warmupIterations }: Options) => {
  if (filter && !`${group} ${name}`.includes(filter)) return;
  try {
    for (let i = 0; i < warmupIterations; i++) fn();
    const samples: Array<number> = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      fn();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1]!;
    const rate = groupBytes ? `${(groupBytes / 1e3 / median).toFixed(1).padStart(7)} MB/s` : "";
    console.log(`${median.toFixed(1).padStart(10)} ms ${rate}  ${name}`);
  } catch (error) {
    console.log(`     error  ${name}: ${String(error).slice(0, 120)}`);
  }
};

for (const [name, corpus] of Object.entries(corpora)) {
  const bytes = corpus.reduce((n, t) => n + t.length, 0);
  const corpusFences = corpus.flatMap(fences);
  describe(`${name} (${corpus.length} docs, ${(bytes / 1e3).toFixed(0)} KB, ${corpusFences.length} fences)`, () => {
    bench("t3: parse (remark + plugins, mdast)", () => void corpus.forEach((t) => parseOnly.runSync(parseOnly.parse(t))), options);
    bench("t3: to hast (parse + rehype + sanitize)", () => void corpus.forEach(t3Hast), options);
    bench("t3: to React elements", () => void corpus.forEach(t3Element), options);
    bench("t3: elements + renderToStaticMarkup", () => void corpus.forEach((t) => renderToStaticMarkup(t3Element(t))), options);
    bench("highlights: all fences to HTML", () => void corpusFences.forEach((f) => highlight(f.lang, f.code)), options);
    bench("md4w (md4c, zig/wasm): html", () => void corpus.forEach((t) => md4w.mdToHtml(t, { parseFlags: md4wFlags })), options);
    bench("md4w: json tree", () => void corpus.forEach((t) => md4w.mdToJSON(t, { parseFlags: md4wFlags })), options);
    bench("markdown-wasm (md4c): html", () => void corpus.forEach((t) => markdownWasm.parse(t)), options);
    bench("md4x (md4c, unjs): html", () => void corpus.forEach((t) => md4x.renderToHtml(t)), options);
    bench("md4x: ast", () => void corpus.forEach((t) => md4x.parseAST(t)), options);
    bench("comrak (rust/wasm): html", () => void corpus.forEach((t) => comrak.markdownToHTML(t, comrakOptions)), options);
    bench("markdown-it: html", () => void corpus.forEach((t) => markdownIt.render(t)), options);
    bench("marked: html", () => void corpus.forEach((t) => marked.parse(t, { gfm: true })), options);
    bench("commonmark.js: html", () => void corpus.forEach((t) => cmRenderer.render(cmParser.parse(t))), options);
    bench("micromark + gfm: html", () => void corpus.forEach((t) => micromark(t, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] })), options);
    bench("@lezer/markdown + GFM: tree only", () => void corpus.forEach((t) => lezerParser.parse(t)), options);
  }, bytes);
}

describe("w1 streaming: 500 whole-text snapshots", () => {
  bench("t3 today: split blocks, render the last block", () => {
    for (const snapshot of w1Snapshots) {
      const blocks = splitMarkdownBlocks(snapshot) ?? [snapshot];
      t3Element(blocks.at(-1)!);
    }
  }, { iterations: 3, warmupIterations: 1 });
  bench("t3 without splitting: render the whole snapshot", () => {
    for (const snapshot of w1Snapshots) t3Element(snapshot);
  }, { iterations: 1, warmupIterations: 0 });
  bench("md4w html: split blocks, render the last block", () => {
    for (const snapshot of w1Snapshots) {
      const blocks = splitMarkdownBlocks(snapshot) ?? [snapshot];
      md4w.mdToHtml(blocks.at(-1)!, { parseFlags: md4wFlags });
    }
  }, options);
  bench("md4w html: whole snapshot", () => {
    for (const snapshot of w1Snapshots) md4w.mdToHtml(snapshot, { parseFlags: md4wFlags });
  }, options);
});
