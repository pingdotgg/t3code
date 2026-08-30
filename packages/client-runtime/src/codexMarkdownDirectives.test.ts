import { describe, expect, it } from "vite-plus/test";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  remarkCodexDirectives,
  renderCodexDirectivesForCopy,
  renderCodexFileCitationsAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "./codexMarkdownDirectives.js";

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
const ARTIFACT_TEMPLATE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

function parse(markdown: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkCodexDirectives);
  return processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
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

  it.each([
    "Meeting at 10:30",
    "Open src/main.ts:42",
    "Use :hover and :tada:",
    "::note",
    ":::note\ncontent\n:::",
    ':codex-file-citation-extra{path="outputs/report.xlsx"}',
    "::artifact-template-extra",
  ])("does not change unrelated colon syntax: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });

  it.each([
    ':codex-file-citation{purpose="output"}',
    '::artifact-template{skill_name="artifact-template-hello-world"}',
  ])("keeps malformed supported directives literal: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });
});

describe("native Markdown adapters", () => {
  it("uses the same parser to render file citations as portable links", () => {
    expect(renderCodexFileCitationsAsMarkdown(`Created ${FILE_CITATION}.`)).toBe(
      "Created [report.xlsx](<outputs/report.xlsx>).",
    );
  });

  it.each([
    `\\${FILE_CITATION}`,
    `\`${FILE_CITATION}\``,
    `\`\`\`text\n${FILE_CITATION}\n\`\`\``,
    `[See ${FILE_CITATION}](https://example.com)`,
  ])("does not render excluded citation syntax: %s", (markdown) => {
    expect(renderCodexFileCitationsAsMarkdown(markdown)).toBe(markdown);
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
    expect(renderCodexDirectivesForCopy(`Created ${FILE_CITATION}.\n\n${ARTIFACT_TEMPLATE}`)).toBe(
      "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
    );
  });

  it("leaves excluded and malformed directive source unchanged", () => {
    const markdown = [
      `\`${FILE_CITATION}\``,
      '::artifact-template{display_name="Hello World"}',
    ].join("\n\n");

    expect(renderCodexDirectivesForCopy(markdown)).toBe(markdown);
  });
});
