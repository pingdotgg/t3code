import { describe, expect, it } from "vite-plus/test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  remarkCodexDirectives,
  renderCodexDirectivesForCopy,
  renderCodexInlineDirectivesAsMarkdown,
  renderCodexMarkdownForNativeDisplay,
  splitCodexArtifactTemplateMarkdown,
} from "./codexMarkdownDirectives.ts";
import { parseMarkdownFileLink } from "./markdownLinks.ts";

interface TestNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
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

const FILE_CITATION = ':codex-file-citation{path="outputs/report.xlsx" purpose="output"}';
const FOLLOW_UP =
  ':codex-followup[Prepare print version]{prompt="Prepare the document for printing."}';
const ARTIFACT_TEMPLATE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
// OpenAI web-search citation markers: U+E200 opens, U+E202 separates fields, U+E201 closes.
const WEB_CITATION_MARKDOWN =
  "Prices rose 3%. \uE200cite\uE202turn816200view0\uE201 Rates held. \uE200cite\uE202turn0search0\uE202turn0search3\uE201";
const WEB_CITATION_MARKER = /[\uE200-\uE202]|turn\d+(?:view|search)\d+/u;

function parse(markdown: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkCodexDirectives);
  return processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
}

function textContent(node: TestNode): string {
  return node.value ?? (node.children ?? []).map(textContent).join("");
}

function parseOrdinaryMarkdown(markdown: string): TestNode {
  return unified().use(remarkParse).parse(markdown) as TestNode;
}

describe("remarkCodexDirectives", () => {
  it("renders a file citation as a link without changing its source position", () => {
    const markdown = `Created ${FILE_CITATION}.`;
    const link = parse(markdown).children?.[0]?.children?.[1];

    expect(link).toMatchObject({
      type: "link",
      url: "outputs/report.xlsx",
      children: [{ type: "text", value: "report.xlsx" }],
      position: {
        start: { offset: markdown.indexOf(FILE_CITATION) },
        end: { offset: markdown.indexOf(FILE_CITATION) + FILE_CITATION.length },
      },
    });
  });

  it("renders an artifact template as semantic block metadata", () => {
    expect(parse(ARTIFACT_TEMPLATE).children?.[0]).toMatchObject({
      type: "paragraph",
      children: [],
      data: {
        hName: "div",
        hProperties: {
          dataCodexArtifactTemplate: "true",
          dataArtifactKind: "document",
          dataDisplayName: "Hello World",
          dataSkillName: "artifact-template-hello-world",
        },
      },
    });
  });

  it("does not display web citation markers", () => {
    const text = textContent(parse(WEB_CITATION_MARKDOWN));

    expect(text).toContain("Prices rose 3%.");
    expect(text).toContain("Rates held.");
    expect(text).not.toMatch(WEB_CITATION_MARKER);
    expect(textContent(parse("red \uE200cite\uE202turn0search0\uE201**blue**"))).toBe("red blue");
  });

  it("keeps web citation markers out of a bare URL they follow", () => {
    const markdown = "See https://nodejs.orgciteturn0search0 for details.";
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCodexDirectives);
    const tree = processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
    const link = tree.children?.[0]?.children?.find((node) => node.type === "link");

    expect(link?.url).toBe("https://nodejs.org");
  });

  it.each([
    "Meeting at 10:30",
    ":::note\ncontent\n:::",
    ':codex-file-citation-extra{path="outputs/report.xlsx"}',
    ':codex-followup-extra[Label]{prompt="Prompt"}',
  ])("does not change unrelated colon syntax: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });

  it.each([
    ':codex-file-citation{purpose="output"}',
    ":codex-followup[Prepare print version]",
    ':codex-followup[ ]{prompt="Prepare the document for printing."}',
  ])("keeps malformed supported directives literal: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });
});

describe.each([
  { name: "renderCodexDirectivesForCopy", render: renderCodexDirectivesForCopy },
  { name: "renderCodexInlineDirectivesAsMarkdown", render: renderCodexInlineDirectivesAsMarkdown },
])("$name file citation round trips", ({ render }) => {
  // regression: #12243 copied Codex citations keep their backslashes
  it.each([
    "C:\\Users\\test\\[draft]\\report.md",
    "\\\\server\\share\\report.md",
    "/tmp/report%5C.md",
  ])("preserves the literal path and line: %s", (path) => {
    const markdown = render(`:codex-file-citation{path="${path}" line_range_start="7"}`);
    const link = parseOrdinaryMarkdown(markdown).children?.[0]?.children?.[0];

    expect(link?.type).toBe("link");
    expect(parseMarkdownFileLink(link?.url ?? "")).toEqual({ path, line: 7 });
  });
});

describe.each([
  { name: "renderCodexDirectivesForCopy", render: renderCodexDirectivesForCopy },
  { name: "renderCodexMarkdownForNativeDisplay", render: renderCodexMarkdownForNativeDisplay },
])("$name web citation markers", ({ render }) => {
  it.each([
    [WEB_CITATION_MARKDOWN, "Prices rose 3%. Rates held."],
    ["red \uE200cite\uE202turn0search0\uE201blue", "red blue"],
    ["red \uE200cite\uE202turn0search0\uE201**blue**", "red **blue**"],
    ["red \uE200cite\uE202turn0search0\uE201[blue](https://a.dev)", "red [blue](https://a.dev)"],
    ["red \uE200cite\uE202turn0search0\uE201`blue`", "red `blue`"],
    ["**Result \uE200cite\uE202turn0search0\uE201**.", "**Result**."],
    [
      ':codex-file-citation{path="src/foo.ts" note="\uE200cite\uE202turn0search0\uE201"} trailing',
      "[foo.ts](<src/foo.ts>) trailing",
    ],
    ["[s](https://a.dev\uE200cite\uE202turn0search0\uE201)", "[s](https://a.dev)"],
    ["[s]\n\n[s]: https://a.dev\uE200cite\uE202turn0search0\uE201", "[s]\n\n[s]: https://a.dev"],
    [':codex-followup[Read more citeturn0search0]{prompt="Read more"}', "Read more"],
    ["`citeturn0search0`", "`citeturn0search0`"],
    [':codex-followup[Show `citeturn0search0`]{prompt="Show it"}', "Show `citeturn0search0`"],
  ])("leaves the markers out of the rendered Markdown, except in code", (input, expected) => {
    expect(render(input)).toBe(expected);
  });
});

describe("native Markdown adapters", () => {
  it("renders follow-up suggestions as their label Markdown", () => {
    expect(
      renderCodexInlineDirectivesAsMarkdown(
        `- ${FOLLOW_UP}\n- :codex-followup[Review **document**]{prompt="Review it."}`,
      ),
    ).toBe("- Prepare print version\n- Review **document**");
  });

  it.each([
    `\\${FILE_CITATION}`,
    `\`${FILE_CITATION}\``,
    `[See ${FILE_CITATION}](https://example.com)`,
  ])("does not render excluded citation syntax: %s", (markdown) => {
    expect(renderCodexInlineDirectivesAsMarkdown(markdown)).toBe(markdown);
  });

  it("splits artifact cards from surrounding native Markdown", () => {
    expect(splitCodexArtifactTemplateMarkdown(`Before\n\n${ARTIFACT_TEMPLATE}\n\nAfter`)).toEqual([
      { kind: "markdown", markdown: "Before\n\n", sourceOffset: 0 },
      {
        kind: "artifact-template",
        sourceOffset: 8,
        template: {
          artifactKind: "document",
          displayName: "Hello World",
          skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
          skillName: "artifact-template-hello-world",
        },
      },
      {
        kind: "markdown",
        markdown: "\n\nAfter",
        sourceOffset: 8 + ARTIFACT_TEMPLATE.length,
      },
    ]);
  });

  it("leaves malformed and code artifact-template examples in Markdown", () => {
    const malformed = '::artifact-template{display_name="Hello World"}';
    const code = `\`${ARTIFACT_TEMPLATE}\``;
    expect(splitCodexArtifactTemplateMarkdown(malformed)).toEqual([
      { kind: "markdown", markdown: malformed, sourceOffset: 0 },
    ]);
    expect(splitCodexArtifactTemplateMarkdown(code)).toEqual([
      { kind: "markdown", markdown: code, sourceOffset: 0 },
    ]);
  });
});

describe("directive copy adapter", () => {
  it("copies the Markdown representations shown by citation chips and template cards", () => {
    expect(
      renderCodexDirectivesForCopy(
        `Created ${FILE_CITATION}.\n\n${ARTIFACT_TEMPLATE}\n\n- ${FOLLOW_UP}`,
      ),
    ).toBe(
      "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)\n\n- Prepare print version",
    );
  });
});
