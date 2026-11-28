import { describe, expect, it } from "vite-plus/test";

import { markdownTree } from "../../markdown/wordsHast";
import { isClosedCodeFence } from "./MarkdownCodeBlock.logic";

describe("isClosedCodeFence", () => {
  it.each(["\n", "\r\n", "\r"])("tells closed from unclosed fences with %j line endings", (eol) => {
    for (const closed of [false, true]) {
      const source = ["```sh", "echo hi", ...(closed ? ["```"] : [])].join(eol);
      const [pre] = markdownTree(source).children;
      const code = pre?.type === "element" ? pre.children[0] : undefined;
      const content = code?.type === "element" ? code.children[0] : undefined;
      if (pre?.type !== "element" || content?.type !== "text") {
        throw new Error("Expected a parsed code block");
      }
      expect(isClosedCodeFence(pre, source, content.value)).toBe(closed);
    }
  });
});
