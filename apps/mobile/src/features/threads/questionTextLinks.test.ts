import { describe, expect, it } from "vite-plus/test";

import { splitQuestionTextLinks } from "./questionTextLinks";

describe("splitQuestionTextLinks", () => {
  it("links a bare URL without its trailing sentence punctuation", () => {
    expect(splitQuestionTextLinks("Please open https://example.com/a?b=1, then answer.")).toEqual([
      { kind: "text", text: "Please open " },
      { kind: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { kind: "text", text: ", then answer." },
    ]);
  });

  it("links Markdown labels to their destination", () => {
    expect(splitQuestionTextLinks("See [the docs](https://example.com/docs) first")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "the docs", href: "https://example.com/docs" },
      { kind: "text", text: " first" },
    ]);
  });

  it("keeps balanced parentheses in bare and Markdown URLs", () => {
    const wiki = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    expect(splitQuestionTextLinks(`(see ${wiki}).`)).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", text: wiki, href: wiki },
      { kind: "text", text: ")." },
    ]);
    expect(splitQuestionTextLinks(`[math](${wiki})`)).toEqual([
      { kind: "link", text: "math", href: wiki },
    ]);
  });

  it("leaves text without HTTP(S) links untouched", () => {
    expect(splitQuestionTextLinks("Use [x](javascript:alert(1)) or ftp://host")).toEqual([
      { kind: "text", text: "Use [x](javascript:alert(1)) or ftp://host" },
    ]);
  });
});
