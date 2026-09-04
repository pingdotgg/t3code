import { describe, expect, it } from "vite-plus/test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  CODEX_CITATION_HAST_PROPERTIES,
  codexCitationFromHastProperties,
  codexCitationMarkdown,
  codexCitationText,
  remarkCodexCitations,
  renderCodexCitationsAsMarkdown,
  type CodexCitation,
} from "./codexCitations.ts";
import { remarkCodexDirectives } from "./codexMarkdownDirectives.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";

interface TestNode {
  readonly type: string;
  readonly value?: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly data?: {
    readonly hName?: string;
    readonly hProperties?: Readonly<Record<string, unknown>>;
  };
  readonly children?: readonly TestNode[];
}

function marker(...parts: string[]): string {
  return `\uE200cite\uE202${parts.join("\uE202")}\uE201`;
}

const SCREENSHOT_CITATION = marker("turn0view0");

function parse(markdown: string, options: { readonly isStreaming?: boolean } = {}): TestNode {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkNormalizeListItemIndentation)
    .use(remarkCodexDirectives)
    .use(remarkCodexCitations, options);
  return processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
}

function citationNodes(tree: TestNode): TestNode[] {
  return [
    ...(tree.data?.hName === "span" ? [tree] : []),
    ...(tree.children?.flatMap(citationNodes) ?? []),
  ];
}

function citations(markdown: string): (CodexCitation | null)[] {
  return citationNodes(parse(markdown)).map((node) =>
    codexCitationFromHastProperties(node.data?.hProperties),
  );
}

describe("remarkCodexCitations", () => {
  it("recognizes the screenshot's source marker and retains its exact source position", () => {
    const markdown = `Both reporters proposed refreshing after rejection. ${SCREENSHOT_CITATION}`;
    const [node] = citationNodes(parse(markdown));
    expect(node).toMatchObject({
      type: "text",
      value: "[Source 1: turn0view0]",
      position: {
        start: { offset: markdown.indexOf(SCREENSHOT_CITATION) },
        end: { offset: markdown.length },
      },
      data: { hName: "span" },
    });
    expect(codexCitationFromHastProperties(node?.data?.hProperties)).toEqual({
      raw: SCREENSHOT_CITATION,
      sources: [{ id: "turn0view0", number: 1 }],
    });
    expect(Object.keys(node?.data?.hProperties ?? {})).toEqual(CODEX_CITATION_HAST_PROPERTIES);
  });

  it("numbers sources by first appearance and deduplicates grouped references", () => {
    const grouped = marker("alpha__id__", "turn0search0", "alpha__id__", "L8-L13");
    const repeated = marker("turn0search0", "turn2view3", "L9");
    expect(citations(`**${grouped}**\n\n- Again ${repeated}.`)).toEqual([
      {
        raw: grouped,
        sources: [
          { id: "alpha__id__", number: 1 },
          { id: "turn0search0", number: 2 },
        ],
        locator: "L8-L13",
      },
      {
        raw: repeated,
        sources: [
          { id: "turn0search0", number: 2 },
          { id: "turn2view3", number: 3 },
        ],
        locator: "L9",
      },
    ]);
  });

  it("resets numbering when a processor is reused for another document", () => {
    const processor = unified().use(remarkParse).use(remarkCodexCitations).freeze();
    for (const id of ["turn0view0", "other-id"]) {
      const markdown = marker(id);
      const tree = processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
      const [node] = citationNodes(tree);
      expect(codexCitationFromHastProperties(node?.data?.hProperties)?.sources).toEqual([
        { id, number: 1 },
      ]);
    }
  });

  it.each(["L42", "L8-L13"])("keeps a locator-shaped sole source ID: %s", (id) => {
    const source = marker(id);
    const located = marker(id, "L5-L8");
    expect(citations(`${source} ${located}`)).toEqual([
      { raw: source, sources: [{ id, number: 1 }] },
      { raw: located, sources: [{ id, number: 1 }], locator: "L5-L8" },
    ]);
    expect(renderCodexCitationsAsMarkdown(source)).toBe(`\\[Source 1: ${id}\\]`);
  });

  it("handles consecutive markers without swallowing the following text", () => {
    const markdown = `Before ${SCREENSHOT_CITATION}${marker("second")}, after.`;
    expect(renderCodexCitationsAsMarkdown(markdown)).toBe(
      "Before \\[Source 1: turn0view0\\]\\[Source 2: second\\], after.",
    );
  });

  it.each([
    ["inline code", `\`${SCREENSHOT_CITATION}\``],
    ["fenced code", `\`\`\`md\n${SCREENSHOT_CITATION}\n\`\`\``],
    ["indented code", `    ${SCREENSHOT_CITATION}`],
    ["quoted code", `>     ${SCREENSHOT_CITATION}`],
    ["link label", `[Source ${SCREENSHOT_CITATION}](https://example.com)`],
    ["link destination", `[Source](https://example.com/${SCREENSHOT_CITATION})`],
    ["link title", `[Source](https://example.com "${SCREENSHOT_CITATION}")`],
    ["bare URL", `https://example.com/${SCREENSHOT_CITATION}`],
    ["bare www URL", `www.example.com/${SCREENSHOT_CITATION}`],
    ["angle-bracket URL", `<https://example.com/${SCREENSHOT_CITATION}>`],
    ["reference link", `[${SCREENSHOT_CITATION}][ref]\n\n[ref]: https://example.com`],
    ["image label", `![Source ${SCREENSHOT_CITATION}](image.png)`],
    ["image destination", `![Source](images/${SCREENSHOT_CITATION})`],
    ["reference image", `![${SCREENSHOT_CITATION}][ref]\n\n[ref]: image.png`],
    ["HTML code", `Before <code>${SCREENSHOT_CITATION}</code> after.`],
    ["HTML anchor", `Before <a href="https://example.com">${SCREENSHOT_CITATION}</a> after.`],
    ["HTML preformatted block", `<pre>\n${SCREENSHOT_CITATION}\n</pre>`],
    ["HTML script", `<script>${SCREENSHOT_CITATION}</script>`],
    ["HTML attribute", `<span title="${SCREENSHOT_CITATION}">text</span>`],
  ])("preserves citations in %s", (_name, markdown) => {
    expect(citations(markdown)).toEqual([]);
    expect(renderCodexCitationsAsMarkdown(markdown)).toBe(markdown);
  });

  it("excluded examples do not consume source numbers or suppress following citations", () => {
    const markdown = `Before <code>${marker("excluded")}</code> ${SCREENSHOT_CITATION}.`;
    expect(citations(markdown)).toEqual([
      { raw: SCREENSHOT_CITATION, sources: [{ id: "turn0view0", number: 1 }] },
    ]);
  });

  it("does not mistake commented HTML for an open code element", () => {
    expect(citations(`<!-- <code> -->\n\n${SCREENSHOT_CITATION}`)).toHaveLength(1);
  });

  it("does not mistake a quoted HTML attribute for an open code element", () => {
    const html = '<span title="<code>">text</span>';
    expect(citations(`Before ${html} ${SCREENSHOT_CITATION}`)).toHaveLength(1);
    expect(renderCodexCitationsAsMarkdown(`${html}\n\n${SCREENSHOT_CITATION}`)).toBe(
      `${html}\n\n\\[Source 1: turn0view0\\]`,
    );
  });

  it("keeps HTML inside an excluded Markdown link from changing later citations", () => {
    expect(citations(`[<code>label](https://example.com) ${SCREENSHOT_CITATION}`)).toHaveLength(1);
  });

  it("keeps URL-contained markers literal without consuming source numbers", () => {
    const url = `https://example.com/${marker("excluded")}`;
    expect(renderCodexCitationsAsMarkdown(`${url}\n\n${SCREENSHOT_CITATION}`)).toBe(
      `${url}\n\n\\[Source 1: turn0view0\\]`,
    );
    expect(citations(`${url}\n\n${SCREENSHOT_CITATION}`)).toEqual([
      { raw: SCREENSHOT_CITATION, sources: [{ id: "turn0view0", number: 1 }] },
    ]);
  });

  it("leaves markers inside Codex directives unchanged without consuming source numbers", () => {
    const file = `:codex-file-citation{path="outputs/${marker("excluded-file")}.txt"}`;
    const artifact = `::artifact-template{skill_name="artifact-template-report" skill_directory="/skills/report" display_name="Report ${marker("excluded-template")}" artifact_kind="document"}`;
    const markdown = `${file}\n\n${artifact}\n\nResult ${SCREENSHOT_CITATION}.`;
    expect(renderCodexCitationsAsMarkdown(markdown)).toBe(
      `${file}\n\n${artifact}\n\nResult \\[Source 1: turn0view0\\].`,
    );
    expect(citations(markdown)).toEqual([
      { raw: SCREENSHOT_CITATION, sources: [{ id: "turn0view0", number: 1 }] },
    ]);
  });

  it("numbers recovered overindented-list citations using original source positions", () => {
    const first = marker("first");
    const second = marker("second");
    const markdown = `-       A ${first}.\n\nOther ${second}.`;
    expect(renderCodexCitationsAsMarkdown(markdown)).toBe(
      "-       A \\[Source 1: first\\].\n\nOther \\[Source 2: second\\].",
    );
    const nodes = citationNodes(parse(markdown));
    for (const [index, raw] of [first, second].entries()) {
      expect(nodes[index]?.position).toMatchObject({
        start: { offset: markdown.indexOf(raw) },
        end: { offset: markdown.indexOf(raw) + raw.length },
      });
    }
  });

  it.each([
    "\uE200image\uE202turn0view0\uE201",
    "\uE200filecite\uE202turn0file0\uE201",
    "\uE200CITE\uE202turn0view0\uE201",
    "\uE200cite\uE201",
    marker(""),
    marker("turn0view0", ""),
    marker("two words"),
    marker("source.with.dots"),
    marker("https://example.com"),
    marker("source", "L8–L13"),
    marker("source\nnext"),
  ])("preserves unsupported or malformed markers: %s", (markdown) => {
    expect(citations(markdown)).toEqual([]);
    expect(renderCodexCitationsAsMarkdown(markdown)).toBe(markdown);
    expect(renderCodexCitationsAsMarkdown(markdown, { isStreaming: true })).toBe(markdown);
  });
});

describe("streaming citations", () => {
  it("hides an unfinished recognized tail and restores it after streaming stops", () => {
    const complete = marker("source__id", "second-id", "L8-L13");
    for (let length = 1; length < complete.length; length += 1) {
      const partial = complete.slice(0, length);
      expect(renderCodexCitationsAsMarkdown(`Before ${partial}`, { isStreaming: true })).toBe(
        "Before ",
      );
      expect(renderCodexCitationsAsMarkdown(`Before ${partial}`)).toBe(`Before ${partial}`);
    }
    expect(renderCodexCitationsAsMarkdown(complete, { isStreaming: true })).toBe(
      "\\[Source 1: source\\_\\_id; Source 2: second-id; L8-L13\\]",
    );
  });

  it.each([
    "Before \uE200cite\uE202source\n\nAfter",
    "Before \uE200cite\uE202source more text",
    "Before \uE200chart",
    "Before \uE200citation",
    "Before \uE200cite\uE202source\uE202\uE202",
    "`\uE200cite\uE202source`",
    "```text\n\uE200cite\uE202source",
    "    \uE200cite\uE202source",
    "Before <code>\uE200cite\uE202source",
    'Before <a href="https://example.com">\uE200cite\uE202source',
    "https://example.com/\uE200cite\uE202source",
  ])("does not hide excluded or non-tail text: %s", (markdown) => {
    expect(renderCodexCitationsAsMarkdown(markdown, { isStreaming: true })).toBe(markdown);
  });

  it("keeps completed citations visible while hiding only the unfinished final marker", () => {
    expect(
      renderCodexCitationsAsMarkdown(`${SCREENSHOT_CITATION} after \uE200cite\uE202next`, {
        isStreaming: true,
      }),
    ).toBe("\\[Source 1: turn0view0\\] after ");
  });

  it("recognizes a streaming tail in a recovered overindented list", () => {
    const markdown = "-       A \uE200cite\uE202source";
    expect(renderCodexCitationsAsMarkdown(markdown, { isStreaming: true })).toBe("-       A ");
    expect(renderCodexCitationsAsMarkdown(markdown)).toBe(markdown);
  });
});

describe("portable citation Markdown", () => {
  it("preserves every unrelated source byte, including escapes, entities and spacing", () => {
    const before = "# Heading\n\n🦊 \\*literal\\* &amp; **bold**  \n> quote ";
    const after = "\n\n- [link](<https://example.com>)\n\n```js\nconst value = 1;\n```\n";
    expect(renderCodexCitationsAsMarkdown(`${before}${SCREENSHOT_CITATION}${after}`)).toBe(
      `${before}\\[Source 1: turn0view0\\]${after}`,
    );
    const ordinary = `${before}${after}`;
    expect(renderCodexCitationsAsMarkdown(ordinary)).toBe(ordinary);
  });

  it("escapes labels and IDs so they cannot turn into Markdown links or emphasis", () => {
    const citation = {
      raw: marker("__opaque_id__"),
      sources: [{ id: "__opaque_id__", number: 1 }],
    };
    const markdown = codexCitationMarkdown(citation);
    expect(markdown).toBe("\\[Source 1: \\_\\_opaque\\_id\\_\\_\\]");
    expect(codexCitationText(citation)).toBe("[Source 1: __opaque_id__]");
    const tree = unified().use(remarkParse).parse(markdown);
    expect(tree.children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: "[Source 1: __opaque_id__]" }] },
    ]);
  });

  it("never guesses a URL from a source ID", () => {
    const rendered = renderCodexCitationsAsMarkdown(marker("example-com", "turn0view0", "L8"));
    expect(rendered).toBe("\\[Source 1: example-com; Source 2: turn0view0; L8\\]");
    expect(rendered).not.toContain("](");
  });
});

describe("citation HAST payload validation", () => {
  const valid: CodexCitation = {
    raw: marker("turn0view0", "L8-L13"),
    sources: [{ id: "turn0view0", number: 3 }],
    locator: "L8-L13",
  };

  it("round-trips a valid payload without requiring a link destination", () => {
    expect(codexCitationFromHastProperties({ dataCodexCitation: JSON.stringify(valid) })).toEqual(
      valid,
    );
  });

  it.each([undefined, null, {}, { dataCodexCitation: 1 }, { dataCodexCitation: "invalid json" }])(
    "rejects missing or malformed properties",
    (properties) => {
      expect(codexCitationFromHastProperties(properties)).toBeNull();
    },
  );

  it.each([
    null,
    1,
    [],
    { ...valid, raw: marker("https://example.com") },
    { ...valid, raw: 3 },
    { ...valid, sources: [] },
    { ...valid, sources: [null] },
    { ...valid, sources: [{ id: "different", number: 1 }] },
    { ...valid, sources: [{ id: "turn0view0", number: 0 }] },
    { ...valid, sources: [{ id: "turn0view0", number: -1 }] },
    { ...valid, sources: [{ id: "turn0view0", number: 1.5 }] },
    { ...valid, sources: [{ id: "turn0view0", number: "1" }] },
    { ...valid, sources: [{ id: "turn0view0", number: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...valid, locator: "L2" },
    { ...valid, locator: null },
  ])("rejects payloads inconsistent with the source marker", (payload) => {
    expect(
      codexCitationFromHastProperties({ dataCodexCitation: JSON.stringify(payload) }),
    ).toBeNull();
  });
});
