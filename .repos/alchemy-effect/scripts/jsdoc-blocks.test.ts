import { describe, expect, test } from "bun:test";
import {
  applyRuns,
  markdownDialect,
  markdownRuns,
} from "../packages/vite-plugin-copy-editor/src/index.ts";
import {
  docBlocks,
  docCommentLines,
  docRegions,
  JSDOC_LINE_PREFIX,
  linkTagText,
  markDocLines,
  regionSource,
  replaceRegion,
} from "./jsdoc-blocks.ts";

const FILE = `import x from "y";

/**
 * An S3 bucket for storing objects in AWS.
 *
 * A bucket name is auto-generated unless you provide one via
 * \`bucketName\`. See {@link BucketPolicy} for access.
 *
 * - first item
 *   continues here
 * - second item
 *
 * ### Creating a Bucket
 * Section prose.
 *
 * **Example:** Basic Bucket
 * \`\`\`typescript
 * const bucket = yield* Bucket("b", {});
 * \`\`\`
 *
 * @resource
 */
export const Bucket = 1;
`;
const START = FILE.indexOf("/**");
const markdown = {
  linePrefix: JSDOC_LINE_PREFIX,
  atomics: [
    {
      pattern: /\{@link\s+([^}]+)\}/,
      text: (m: RegExpExecArray) => linkTagText(m[1]!),
    },
  ],
};

const blockText = (b: { start: number; end: number }) =>
  FILE.slice(b.start, b.end);

describe("docBlocks", () => {
  const blocks = docBlocks(docCommentLines(FILE, START));

  test("finds rendered prose blocks and skips code and tags", () => {
    expect(blocks.map((b) => [b.kind, blockText(b)])).toEqual([
      ["paragraph", "An S3 bucket for storing objects in AWS."],
      [
        "paragraph",
        "A bucket name is auto-generated unless you provide one via\n * `bucketName`. See {@link BucketPolicy} for access.",
      ],
      ["listItem", "first item\n *   continues here"],
      ["listItem", "second item"],
      ["sectionTitle", "Creating a Bucket"],
      ["paragraph", "Section prose."],
      ["exampleTitle", "Basic Bucket"],
    ]);
  });

  test("an edit rewrites the JSDoc in place", () => {
    const block = blocks[1]!;
    const runs = markdownRuns(FILE, block.start, block.end, markdown);
    const before = [
      "A bucket name is auto-generated unless you provide one via\n",
      "bucketName",
      ". See ",
      "BucketPolicy",
      " for access.",
    ];
    const after = [...before];
    after[0] =
      "A bucket name is generated for you unless you provide one via\n";
    after[4] = " for permissions.";
    const out = applyRuns(FILE, runs, markdownDialect(markdown), {
      before,
      after,
    });
    expect(out).toContain(
      " * A bucket name is generated for you unless you provide one via\n * `bucketName`. See {@link BucketPolicy} for permissions.",
    );
    // The rest of the file is untouched.
    expect(
      out
        .replace("generated for you", "auto-generated")
        .replace("permissions.", "access."),
    ).toBe(FILE);
  });

  test("link text is locked", () => {
    const block = blocks[1]!;
    const runs = markdownRuns(FILE, block.start, block.end, markdown);
    const before = [
      "A bucket name is auto-generated unless you provide one via\n",
      "bucketName",
      ". See ",
      "BucketPolicy",
      " for access.",
    ];
    const after = [...before];
    after[3] = "OtherThing";
    expect(() =>
      applyRuns(FILE, runs, markdownDialect(markdown), { before, after }),
    ).toThrow(/generated/);
  });
});

const EMPTY_SECTION = `/**
 * Summary.
 *
 * ### Empty Section
 * **Example:** Only
 * \`\`\`ts
 * x();
 * \`\`\`
 * @resource
 */`;

describe("docRegions", () => {
  const lines = docCommentLines(FILE, START);
  const regions = docRegions(lines);

  test("finds the summary, section descriptions, and example bodies", () => {
    expect(regions.map((r) => [r.kind, regionSource(lines, r)])).toEqual([
      [
        "summary",
        "An S3 bucket for storing objects in AWS.\n\nA bucket name is auto-generated unless you provide one via\n`bucketName`. See {@link BucketPolicy} for access.\n\n- first item\n  continues here\n- second item",
      ],
      ["sectionDescription", "Section prose."],
      [
        "exampleBody",
        '```typescript\nconst bucket = yield* Bucket("b", {});\n```',
      ],
    ]);
  });

  test("an empty section gets an empty region after its title", () => {
    const empty = docCommentLines(EMPTY_SECTION, 0);
    const [, description] = docRegions(empty);
    expect(description?.kind).toBe("sectionDescription");
    expect(description!.lastLine).toBeLessThan(description!.firstLine);
    const out = replaceRegion(
      EMPTY_SECTION,
      empty,
      description!,
      "New *prose*.",
    );
    expect(out).toContain(
      " * ### Empty Section\n * New *prose*.\n * **Example:** Only",
    );
  });

  test("replacing a region writes markdown as JSDoc lines", () => {
    const next =
      "A new summary with `code`.\n\n```ts\nconst x = 1;\n```\n\n@mention stays prose";
    const out = replaceRegion(FILE, lines, regions[0]!, next);
    expect(out).toContain(
      "/**\n * A new summary with `code`.\n *\n * ```ts\n * const x = 1;\n * ```\n *\n * \\@mention stays prose\n *\n * ### Creating a Bucket",
    );
    // Round trip: the new region reads back as the markdown written.
    const reread = docCommentLines(out, START);
    expect(regionSource(reread, docRegions(reread)[0]!)).toBe(
      next.replace("@mention", "\\@mention"),
    );
  });

  test("refuses to close the comment", () => {
    expect(() => replaceRegion(FILE, lines, regions[0]!, "oops */")).toThrow(
      /\*\//,
    );
  });

  test("wraps regions and marks the titles outside them", () => {
    const texts = markDocLines(lines, (t) => `id#${t}`).join("\n");
    expect(texts).toContain(
      '<div data-copy="id#r0" data-copy-format="markdown" data-copy-style="docs">\n\nAn S3 bucket',
    );
    expect(texts).toContain("### Creating a Bucket<!--copy:id#0-->");
    expect(texts).toContain("**Example:** Basic Bucket<!--copy:id#1-->");
    expect(texts).not.toContain("AWS.<!--copy");
  });
});

test("replaceRegion collapses extra blank lines outside code only", () => {
  const lines = docCommentLines(FILE, START);
  const region = docRegions(lines)[0]!;
  const out = replaceRegion(
    FILE,
    lines,
    region,
    "One.\n\n\n\nTwo.\n\n```ts\na\n\n\nb\n```",
  );
  expect(out).toContain(
    " * One.\n *\n * Two.\n *\n * ```ts\n * a\n *\n *\n * b\n * ```",
  );
});
