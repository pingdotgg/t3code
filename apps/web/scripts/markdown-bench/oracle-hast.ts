// Compares chatRenderHast with remark-rehype + the chat's rehype plugins on the same mdast.
// node scripts/markdown-bench/run.mjs oracle-hast
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { createRequire } from "node:module";

import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";

import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";

import { rehypeHeadingIds } from "../../src/components/chat/markdownFragments";
import { remarkParseWithoutUnusedSyntax } from "../../src/components/chat/markdownSyntaxGates";
import { rehypeTextDirection } from "../../src/components/chat/markdownTextDirection";
import { chatRenderHast } from "../../src/markdown/chatHast";
import { remarkFastParse } from "../../src/markdown/remarkFastParse";

const dir = NodePath.join(process.env.HOME ?? "", "bench-work/md-bench");
const verbose = Number(process.env.SHOW ?? 3);
const remark = unified().use(remarkParse).use(remarkParseWithoutUnusedSyntax).use(remarkFastParse).use(CHAT_MARKDOWN_REMARK_PLUGINS).freeze();
const rehype = unified()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use([...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds, rehypeTextDirection])
  .freeze();

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${path}: expected ${JSON.stringify(a)?.slice(0, 100)} got ${JSON.stringify(b)?.slice(0, 100)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const diff = firstDifference((a as never)[key], (b as never)[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

const inputs: Array<[string, string]> = [];
const spec = createRequire(NodePath.join(dir, "candidates/package.json"))("commonmark-spec");
for (const test of spec.tests) inputs.push([`spec ${test.number}`, test.markdown]);
for (const name of ["assistant.json", "pr-comments.json"]) {
  const corpus: string[] = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "corpus", name), "utf8"));
  corpus.forEach((text, index) => inputs.push([`${name} ${index}`, text]));
}
let same = 0;
let direct = 0;
const failures: Array<[string, string, string]> = [];
const kinds = new Map<string, number>();
for (const [name, text] of inputs) {
  const file = new VFile(text);
  const mdast = remark.runSync(remark.parse(file), file);
  const actual = chatRenderHast(structuredClone(mdast) as never);
  if (!actual) continue;
  direct++;
  const expected = rehype.runSync(mdast as never, file);
  const diff = firstDifference(JSON.parse(JSON.stringify(expected)), JSON.parse(JSON.stringify(actual)), "");
  if (!diff) {
    same++;
    continue;
  }
  failures.push([name, text, diff]);
  const kind = diff.replace(/\.children\.\d+/g, "").replace(/\d+/g, "N").split(":")[0]!;
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}
console.log(`${direct}/${inputs.length} took the direct path; ${same}/${direct} equal`);
for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(count).padStart(6), kind);
for (const [name, text, diff] of failures.slice(0, verbose)) console.log(`\n--- ${name}\n${JSON.stringify(text.slice(0, 200))}\n${diff}`);
