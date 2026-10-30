// Compares parseMarkdown's mdast with remark-parse's (with the chat's syntax extensions) on the
// CommonMark spec examples and the corpus. node scripts/markdown-bench/run.mjs oracle [spec|corpus] [math]
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { createRequire } from "node:module";

import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";

import { remarkParseWithoutUnusedSyntax } from "../../src/components/chat/markdownSyntaxGates";
import { parseMarkdown } from "../../src/markdown/parseMarkdown";

const dir = process.env.MD_BENCH_DIR ?? NodePath.join(process.env.HOME ?? "", "bench-work/md-bench");
const which = process.argv[3] ?? "all";
const math = process.argv.includes("math");
const verbose = Number(process.env.SHOW ?? 3);

const processor = unified()
  .use(remarkParse)
  .use(remarkParseWithoutUnusedSyntax)
  .use(math ? [[remarkMath, { singleDollarTextMath: true }], ...CHAT_MARKDOWN_REMARK_PLUGINS] : CHAT_MARKDOWN_REMARK_PLUGINS)
  .freeze();

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${path}: expected ${JSON.stringify(a)?.slice(0, 80)} got ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    if (av === undefined && bv === undefined) continue;
    const diff = firstDifference(av, bv, `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

const inputs: Array<[string, string]> = [];
if (which === "all" || which === "spec") {
  const spec = createRequire(NodePath.join(dir, "candidates/package.json"))("commonmark-spec");
  for (const test of spec.tests) inputs.push([`spec ${test.number} (${test.section})`, test.markdown]);
}
if (which === "all" || which === "corpus") {
  for (const name of ["assistant.json", "pr-comments.json"]) {
    const corpus: string[] = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "corpus", name), "utf8"));
    corpus.forEach((text, index) => inputs.push([`${name} ${index}`, text]));
  }
}

let same = 0;
const failures: Array<[string, string, string]> = [];
const kinds = new Map<string, number>();
for (const [name, text] of inputs) {
  const expected = processor.parse(text);
  let actual: unknown;
  try {
    actual = parseMarkdown(text, { math });
  } catch (error) {
    actual = { error: String(error) };
  }
  const diff = firstDifference(JSON.parse(JSON.stringify(expected)), JSON.parse(JSON.stringify(actual)), "");
  if (!diff) {
    same++;
    continue;
  }
  failures.push([name, text, diff]);
  const kind = diff.replace(/\.children\.\d+/g, "").replace(/\d+/g, "N").split(":")[0]!;
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}
console.log(`${same}/${inputs.length} equal`);
for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(count).padStart(6), kind);
for (const [name, text, diff] of failures.slice(0, verbose)) {
  console.log(`\n--- ${name}\n${JSON.stringify(text.slice(0, 300))}\n${diff}`);
}
