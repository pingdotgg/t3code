import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { VFile } from "vfile";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { remarkParseWithoutUnusedSyntax } from "../../src/components/chat/markdownSyntaxGates";
import { chatRenderHast } from "../../src/markdown/chatHast";
import { remarkFastParse } from "../../src/markdown/remarkFastParse";
const corpus: string[] = JSON.parse(NodeFs.readFileSync(NodePath.join(process.env.HOME ?? "", "bench-work/md-bench/corpus/" + (process.env.CORPUS ?? "assistant") + ".json"), "utf8"));
const remark = unified().use(remarkParse).use(remarkParseWithoutUnusedSyntax).use(remarkFastParse).use([...CHAT_MARKDOWN_REMARK_PLUGINS]).freeze();
for (let round = 0; round < 4; round++) for (const text of corpus) { const f = new VFile(text); chatRenderHast(remark.runSync(remark.parse(f), f) as never); }
