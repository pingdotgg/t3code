import { describe, expect, it } from "vite-plus/test";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import {
  markdownForNativeParsing,
  markdownForNativeRendering,
  markdownWithFileEmbeds,
  markdownWithInlineFileLinks,
  markdownWithTableBreaks,
} from "./markdownDocument";
import {
  convertNativeMarkdown,
  convertStreamingMarkdown,
  createNativeMarkdownBlockCache,
  nativeMarkdownPipeline,
  splitMarkdownStreamBlocks,
  type NativeMarkdownPipeline,
  type NativeMarkdownRender,
} from "./markdownStreamBlocks";

const label = (href: string, standalone: boolean) =>
  /\.png$/.test(href) ? `${standalone ? "S" : "N"}:${href}` : null;
const owners = [
  { name: "plain", owner: undefined },
  { name: "embed", owner: label },
] as const;

const sameRender = (a: NativeMarkdownRender, b: NativeMarkdownRender) =>
  a.markdown === b.markdown && [...a.fileHrefs].toString() === [...b.fileHrefs].toString();

/** What the component does while a reply streams. */
function stream(
  text: string,
  owner: typeof label | undefined,
  cache = createNativeMarkdownBlockCache(),
  pipeline: NativeMarkdownPipeline = nativeMarkdownPipeline(owner),
): NativeMarkdownRender | null {
  return convertStreamingMarkdown(text, owner, cache, true, pipeline, 0);
}

// Every prefix of `text`, through one cache, must convert like the whole text (or be refused).
function expectPrefixesMatch(name: string, text: string) {
  for (const { owner } of owners) {
    const cache = createNativeMarkdownBlockCache();
    for (let end = 0; end <= text.length; end += 1) {
      const prefix = text.slice(0, end);
      const streamed = stream(prefix, owner, cache);
      if (streamed === null) continue;
      const expected = convertNativeMarkdown(prefix, owner);
      expect(streamed.markdown, `${name}@${end}`).toBe(expected.markdown);
      expect([...streamed.fileHrefs], `${name}@${end}`).toEqual([...expected.fileHrefs]);
    }
  }
}

const fence =
  "```ts\nexport function f(x: Array<string>) {\n  return `a/b.ts`;\n\n  // blank\n}\n```";
const samples: Record<string, string> = {
  prose: "Intro with `src/a.ts:12` and Array<string>.\n\nSecond paragraph.\n\nThird.",
  fences: `Before\n\n${fence}\n\nAfter \`src/b.ts\`\n\n\`\`\`\nunclosed <div>\n\nstill code`,
  list: "- one `src/a.ts`\n- two\n\n- loose\n\n  continued\n\n  ```sh\n  echo <x>\n\n  more\n  ```\n- last\n\nend",
  quote: "> quoted `x/y.ts`\n>\n> more\n\n> next quote\n\ntail",
  tables: "Text\n| a | b |\n| - | - |\n| `src/a\\|b.ts` | 2 |\n\nmid\n\n| c |\n| - |\n| d |",
  html: 'Use <b>bold</b> and <a href="https://e.com">link</a><br>x\n\nArray<string> and 1 < 2\n\nend',
  images: "![a](pic.png) and ![b](https://e.com/z.jpg)\n\n![c](d.png)\n\ntext",
  windows:
    String.raw`[w](C:\work\.t3\f.md)` + "\n\nplain `src/q.ts`\n\n" + String.raw`[v](<C:\a b\c.md>)`,
  setext: "Title\n===\n\nbody\n\n---\n\nmore",
  indented: "para\n\n    code <b>\n\n    more\n\nafter",
};

// Each of these made a block-by-block conversion differ from the whole-text one in an earlier
// design, so they are kept as named cases.
const pitfalls: Record<string, string> = {
  tripleBacktickProse:
    "To open a fence, type ``` on its own line; see `src/a.ts` for details.\n\nAlso check `src/b.ts`.\n\nDone.",
  literalBacktick:
    "Escape a backtick with `` ` `` as in `src/a.ts`.\n\nSee also `src/b.ts`.\n\nDone.",
  wrappedCodeSpan: "Run `vp test\nrun` on `src/a.ts`.\n\nSee also `src/b.ts`.\n\nDone.",
  brOpensFence: "text<br>```ts\nconst a = 1;\n\nnext `src/a.ts`\n\nlast",
  pOpensFence: "x <p>```\n\nfoo `src/a.ts`\n\nlast",
  removedTagJoinsBackticks: "``<script>``` \n\n`src/z.ts`\n\nlast",
  fakeFenceInfo: "```a`b\nnot a fence `src/q.ts` text\n\nnext",
  linkRewriteOpensFence: "```ts`src/a.ts`\n\n![z](z.png)\n\nlast",
  quoteDefinition: "> [ref]: https://u.com\n\nSee [`src/a.ts`][ref] here\n\nlast",
  listDefinition: "- [ref]: https://u.com\n\nSee [`src/a.ts`][ref] here\n\nlast",
  multiLineDefinition: "See [`src/a.ts`][foo bar] here\n\n[foo\nbar]: https://u.com\n\nlast",
  imageDefinition: "![r][im]\n\n> [im]: x.png\n\nlast",
  htmlDefinition: "A [`src/a.ts`][ref]\n\ny <p>[ref]: https://u.com\n\nz",
  footnote: "Note[^1]\n\nmore\n\n[^1]: the note",
  definition: "See [x][ref] and [`a/b.ts`][ref]\n\nmore\n\n[ref]: https://example.com",
  htmlBlock: "<details>\n<summary>S</summary>\n\nBody `src/z.ts`\n\n</details>\n\nafter",
  htmlBlockInList: "- <![CDATA[\n\t\n`C:\\x\\y.ts`<br/>",
  nbspCloser: "```\ncode\n```\u00a0\n\nafter `src/a.ts`\n\nmore",
  nbspBlank: 'see <a href="https://e.com">foo\n\u00a0\nbar</a> end\n\nnext',
  bomAtStart: "\ufeff```\ncode\n\nafter `src/a.ts`\n\nlast",
  bomLater: "a\n\n\ufeff`a/b.ts:3`\n\nlast",
  crlf: "a\r\n\r\nb `src/a.ts`\r\n\r\nc",
};

describe("convertNativeMarkdown", () => {
  // The conversion the feed ran before the streaming path existed, written out from its passes.
  it("is the whole-text pipeline: parse, file links, file embeds, table breaks", () => {
    for (const sample of [...Object.values(samples), ...Object.values(pitfalls)]) {
      expect(convertNativeMarkdown(sample, undefined).markdown).toBe(
        markdownForNativeRendering(sample, ENRICHED_INLINE_FILE_LINK_REGEX),
      );
      const content = markdownWithInlineFileLinks(
        markdownForNativeParsing(sample),
        ENRICHED_INLINE_FILE_LINK_REGEX,
      );
      const files = markdownWithFileEmbeds(content, label);
      const expected = markdownWithTableBreaks(files.markdown);
      const actual = convertNativeMarkdown(sample, label);
      expect(actual.markdown).toBe(expected);
      expect([...actual.fileHrefs]).toEqual([...files.fileHrefs]);
    }
  });
});

describe("convertStreamingMarkdown", () => {
  it("converts every prefix of a stream like the whole text, reusing one cache", () => {
    for (const [name, sample] of Object.entries({ ...samples, ...pitfalls }))
      expectPrefixesMatch(name, sample);
  });

  it("converts a file link in a block that has no path of its own like the whole text does", () => {
    // The whole text links files because one span looks like a path; every block must follow.
    for (const name of ["tripleBacktickProse", "literalBacktick", "wrappedCodeSpan"] as const) {
      const text = pitfalls[name]!;
      const streamed = stream(text, label);
      expect(streamed, name).not.toBeNull();
      expect(streamed!.markdown, name).toBe(convertNativeMarkdown(text, label).markdown);
    }
  });

  it("refuses text whose blocks can depend on each other", () => {
    for (const name of [
      "quoteDefinition",
      "listDefinition",
      "multiLineDefinition",
      "imageDefinition",
      "htmlDefinition",
      "footnote",
      "definition",
      "htmlBlock",
      "htmlBlockInList",
      "bomAtStart",
      "bomLater",
      "crlf",
      "linkRewriteOpensFence",
      "fakeFenceInfo",
    ] as const)
      expect(splitMarkdownStreamBlocks(pitfalls[name]!), name).toBeNull();
    for (const name of ["brOpensFence", "pOpensFence", "removedTagJoinsBackticks"] as const)
      expect(stream(pitfalls[name]!, label), name).toBeNull();
  });

  it("treats only spaces and tabs as blank", () => {
    expect(splitMarkdownStreamBlocks("a\n\u00a0\nb\n\nc")).toEqual(["a\n\u00a0\nb\n\n", "c"]);
  });

  it("never splits text that is not streaming", () => {
    const cache = createNativeMarkdownBlockCache();
    const text = "First\n\nSecond\n\nThird";
    expect(stream(text, label, cache)).not.toBeNull();
    expect(
      convertStreamingMarkdown(text, label, cache, false, nativeMarkdownPipeline(label), 0),
    ).toBeNull();
    expect(cache.blocks.size).toBe(0);
  });

  it("leaves short text to the whole-text conversion", () => {
    const text = "a\n\nb";
    expect(
      convertStreamingMarkdown(
        text,
        label,
        createNativeMarkdownBlockCache(),
        true,
        nativeMarkdownPipeline(label),
      ),
    ).toBeNull();
  });

  it("converts only blocks that changed", () => {
    const parsed: string[] = [];
    const base = nativeMarkdownPipeline(label);
    const counting: NativeMarkdownPipeline = {
      ...base,
      parse: (block) => {
        parsed.push(block);
        return base.parse(block);
      },
    };
    const cache = createNativeMarkdownBlockCache();
    const text = "First `src/a.ts`\n\nSecond block\n\nThird";
    stream(text, label, cache, counting);
    expect(parsed).toHaveLength(3);
    parsed.length = 0;
    const next = stream(`${text} grows`, label, cache, counting)!;
    expect(parsed).toEqual(["Third grows"]);
    expect(sameRender(next, convertNativeMarkdown(`${text} grows`, label))).toBe(true);
  });

  it("drops cached blocks when the owner changes", () => {
    const cache = createNativeMarkdownBlockCache();
    const text = "One `src/a.ts`\n\nTwo";
    const first = stream(text, label, cache)!;
    const other = (href: string, standalone: boolean) => `X${label(href, standalone) ?? ""}`;
    const second = stream(text, other as typeof label, cache)!;
    expect(sameRender(first, convertNativeMarkdown(text, label))).toBe(true);
    expect(sameRender(second, convertNativeMarkdown(text, other as typeof label))).toBe(true);
  });

  it("re-renders every block when the first file path shows up late", () => {
    const cache = createNativeMarkdownBlockCache();
    const early = "Escape a backtick with `` ` `` as in `src/a.ts`.\n\nMore.\n\nAnd more.";
    const late = `${early}\n\nSee \`src/b.ts\`.`;
    const before = stream(early, label, cache)!;
    expect(before.markdown).toBe(convertNativeMarkdown(early, label).markdown);
    expect(before.markdown).not.toContain("[src/a.ts]");
    const after = stream(late, label, cache)!;
    expect(after.markdown).toBe(convertNativeMarkdown(late, label).markdown);
    expect(after.markdown).toContain("[src/a.ts](<src/a.ts>)");
  });
});

// A small seeded fuzz: sub-line tokens joined into documents, compared cold and at every prefix.
describe("differential against whole-text conversion", () => {
  const tokens = [
    "\n",
    "\n\n",
    "\n\n",
    "\n \n",
    "```",
    "```ts",
    "~~~",
    "    ",
    "- ",
    "1. ",
    "> ",
    "`src/a.ts`",
    "`x`",
    "``",
    "`",
    "[`src/a.ts`][r]",
    "![x](p.png)",
    "[r]: p.png",
    "arr[i]: v",
    "<br>",
    "<p>",
    "<div>",
    "<!-- c -->",
    '<img src="q.png">',
    '<a href="https://e.com">',
    "</a>",
    "|a|b|",
    "|-|-|",
    "| `src/a\\|b.ts` | c |",
    "---",
    "# ",
    "x",
    "word ",
    " ",
    "**",
    "\u00a0",
    "[^1]",
    String.raw`[w](C:\work\f.md)`,
    "`C:\\x\\y.ts`",
    "\\`",
  ];
  it("matches on generated documents, whole and at every prefix", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let count = 0; count < 250; count += 1) {
      const parts = Array.from(
        { length: 3 + Math.floor(random() * 10) },
        () => tokens[Math.floor(random() * tokens.length)]!,
      );
      parts.push("\n\n", "`src/z.ts`");
      expectPrefixesMatch(`doc${count}`, parts.join(""));
    }
  });
});

describe("splitMarkdownStreamBlocks", () => {
  it("splits at blank lines that close every open block and joins back exactly", () => {
    for (const sample of Object.values(samples)) {
      const blocks = splitMarkdownStreamBlocks(sample);
      expect(blocks?.join("")).toBe(sample);
    }
    expect(splitMarkdownStreamBlocks(samples.prose!)).toHaveLength(3);
    expect(splitMarkdownStreamBlocks(samples.list!)?.[0]).toContain("- last");
  });

  it("keeps a fenced code block, blank lines and all, in one piece", () => {
    const blocks = splitMarkdownStreamBlocks(`Before\n\n${fence}\n\nAfter`);
    expect(blocks).toEqual(["Before\n\n", `${fence}\n\n`, "After"]);
  });

  it("does not look inside a fenced code block for syntax that ties blocks together", () => {
    expect(
      splitMarkdownStreamBlocks("```ts\ntype T = { [k: string]: number };\n<View />\n```\n\nafter"),
    ).toHaveLength(2);
  });
});
