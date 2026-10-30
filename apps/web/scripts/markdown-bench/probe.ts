// Prints both trees for one corpus document: node scripts/markdown-bench/run.mjs probe <file> <index> <path>
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { remarkParseWithoutUnusedSyntax } from "../../src/components/chat/markdownSyntaxGates";
import { parseMarkdown } from "../../src/markdown/parseMarkdown";

const dir = NodePath.join(process.env.HOME ?? "", "bench-work/md-bench");
const [, , , file, index, path = ""] = process.argv;
const text = file === "text" ? index! : JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "corpus", file!), "utf8"))[Number(index)];
const processor = unified().use(remarkParse).use(remarkParseWithoutUnusedSyntax).use(CHAT_MARKDOWN_REMARK_PLUGINS).freeze();
const pick = (tree: unknown) => path.split(".").filter(Boolean).reduce((node: any, key) => node?.[key], tree);
const expected = pick(processor.parse(text));
const actual = pick(parseMarkdown(text));
const strip = (node: any): any => JSON.parse(JSON.stringify(node, (k, v) => (k === "position" ? `${v.start.line}:${v.start.column}-${v.end.line}:${v.end.column}` : v)));
console.log("expected", JSON.stringify(strip(expected), null, 1).slice(0, 2500));
console.log("actual  ", JSON.stringify(strip(actual), null, 1).slice(0, 2500));
const p = (expected as any)?.position;
if (p) console.log("source:", JSON.stringify(text.slice(p.start.offset - 20, p.end.offset + 20)));
