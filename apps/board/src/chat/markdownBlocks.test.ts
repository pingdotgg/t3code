import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./markdownBlocks";

const REPLY = [
  "Here is the plan.",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "Next:",
  "",
  "- one",
  "",
  "- two",
  "",
].join("\n");

describe("a streamed reply split into markdown blocks", () => {
  it("Given a paragraph, a fenced block with a blank line inside, and a loose list under its lead-in, when the reply is whole, then the list stays with its lead-in in the last block", () => {
    expect(splitMarkdownBlocks(REPLY)).toEqual([
      "Here is the plan.\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
      "Next:\n\n- one\n\n- two\n",
    ]);
  });

  it("Given the stream stops inside the fence after a blank line, when it is split, then the open fence stays one block", () => {
    expect(splitMarkdownBlocks("Here is the plan.\n\n```ts\nconst a = 1;\n\nconst")).toEqual([
      "Here is the plan.\n\n",
      "```ts\nconst a = 1;\n\nconst",
    ]);
  });

  it("Given the reply grows one character at a time, when each prefix is split, then every finished block stays the same text", () => {
    let previous = splitMarkdownBlocks("") ?? [];
    for (let length = 1; length <= REPLY.length; length++) {
      const blocks = splitMarkdownBlocks(REPLY.slice(0, length)) ?? [];
      expect(blocks.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
      expect(blocks.join("")).toBe(REPLY.slice(0, length));
      previous = blocks;
    }
  });

  it("Given a fenced block whose code has a negated class, a generic, and a dollar pair, when it is split, then the fence ties nothing and the text still splits", () => {
    const text = "Slug it.\n\n```ts\nconst re = /[^a-z0-9]+/g;\n<T>\n$$\n```\n\nDone.\n";
    expect(splitMarkdownBlocks(text)).toEqual([
      "Slug it.\n\n",
      "```ts\nconst re = /[^a-z0-9]+/g;\n<T>\n$$\n```\n\n",
      "Done.\n",
    ]);
  });

  it("Given a footnote definition, when it is split, then the whole text renders as one", () => {
    expect(splitMarkdownBlocks("A claim.[^1]\n\n[^1]: The source.\n")).toBeNull();
  });

  it("Given a link definition that a later block uses, when it is split, then the whole text renders as one", () => {
    expect(splitMarkdownBlocks("See [docs].\n\n[docs]: https://example.com\n")).toBeNull();
  });
});
