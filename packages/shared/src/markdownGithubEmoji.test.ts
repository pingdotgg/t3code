import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expect, it } from "vite-plus/test";

import { expandGithubEmoji, remarkGithubEmoji } from "./markdownGithubEmoji.ts";
import { markdownTaskMarkerOffset } from "./markdownTaskList.ts";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkGithubEmoji);
const text = (node: Nodes): string =>
  node.type === "html"
    ? ""
    : "value" in node
      ? node.value
      : "children" in node
        ? node.children.map(text).join("")
        : "";

it("renders GitHub emoji aliases in prose and leaves literal examples alone", () => {
  const source = [
    'Approved :thumbsup: :-1: 👍 :unknown: <!-- <code> --><span title="<pre>">:tada:</span>',
    ":asterisk:bold:asterisk: \\:tada: `:tada:` <code>:tada:</code> [:tada:](https://x.io/:tada:)",
    "    :tada:\n\n```\n:tada:\n```",
    "[:tada:] [:tada:][] ![:tada:] ![:tada:][]\n\n[:tada:]: https://example.com",
  ].join("\n\n");
  expect(text(parser.parse(source))).toBe(
    "Approved 👍 👎 👍 :unknown: 🎉*️⃣bold*️⃣ :tada: :tada: :tada: 🎉:tada::tada:🎉 🎉  ",
  );
  expect(expandGithubEmoji(source).markdown).toBe(
    source
      .replace("Approved :thumbsup: :-1:", "Approved 👍 👎")
      .replace(">:tada:<", ">🎉<")
      .replace(":asterisk:bold:asterisk:", "\\*️⃣bold\\*️⃣")
      .replace("[:tada:]", "[🎉]"),
  );
});

it("maps native task taps in expanded markdown back to the authored markers", () => {
  const source = ":tada:\n\n- [ ] Ship :rocket: \\*safely*\n- [ ] Keep `:rocket:` literal";
  const expanded = expandGithubEmoji(source);
  expect(expanded.markdown).toBe("🎉\n\n- [ ] Ship 🚀 \\*safely*\n- [ ] Keep `:rocket:` literal");
  const markers = [source.indexOf("[ ]"), source.lastIndexOf("[ ]")];
  for (const [index, label] of ["Ship 🚀 *safely*", "Keep :rocket: literal"].entries()) {
    const offset = markdownTaskMarkerOffset(expanded.markdown, index, label, true);
    expect(offset === null ? null : expanded.sourceOffset(offset)).toBe(markers[index]);
  }
  expect(expandGithubEmoji("10:30:00 :unknown:").markdown).toBe("10:30:00 :unknown:");
});
