// Why documents leave the direct hast path: counts raw HTML kinds per corpus.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { parseMarkdown } from "../../src/markdown/parseMarkdown";
const dir = NodePath.join(process.env.HOME ?? "", "bench-work/md-bench");
for (const name of ["assistant.json", "pr-comments.json"]) {
  const corpus: string[] = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "corpus", name), "utf8"));
  let withHtml = 0, commentOnly = 0, bytes = 0, htmlBytes = 0;
  const tags = new Map<string, number>();
  for (const text of corpus) {
    bytes += text.length;
    const raws: string[] = [];
    const visit = (n: any) => { if (n.type === "html") raws.push(n.value); n.children?.forEach(visit); };
    visit(parseMarkdown(text));
    if (raws.length === 0) continue;
    withHtml++; htmlBytes += text.length;
    const nonComment = raws.filter((v) => !/^<!--[\s\S]*?-->\s*$/.test(v.trim()) || /-->[\s\S]*<!--/.test(v));
    if (nonComment.length === 0) commentOnly++;
    for (const v of nonComment) { const t = /^<\/?([a-zA-Z][\w-]*)/.exec(v.trim())?.[1]?.toLowerCase() ?? (v.trim().startsWith("<!--") ? "#comment+" : "#other"); tags.set(t, (tags.get(t) ?? 0) + 1); }
  }
  console.log(name, { docs: corpus.length, withHtml, commentOnly, htmlShareOfBytes: (htmlBytes / bytes).toFixed(2) });
  console.log("  ", [...tags].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, c]) => `${t}:${c}`).join(" "));
}
