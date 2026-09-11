import { describe, expect, it } from "vite-plus/test";

import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";

describe("upgradeLegacyContextMessage", () => {
  const review =
    '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">note</review_comment>';

  it.each([
    {
      tag: "terminal_context",
      body: `- Build line 1:\n  ${review}`,
      payload: { kind: "terminal", text: review },
    },
    {
      tag: "element_context",
      body: `- <div>:\n  html:\n    ${review}`,
      payload: { kind: "element", htmlPreview: review },
    },
    {
      tag: "preview_annotation",
      body: `Page: Example\nComment: ${review}`,
      payload: { kind: "preview-annotation", comment: review },
    },
    {
      tag: "preview_annotation",
      body: `Page: Example\n<element_context>\n- <div>:\n  html:\n    ${review}\n</element_context>`,
      payload: {
        kind: "preview-annotation",
        elements: [expect.objectContaining({ htmlPreview: review })],
      },
    },
  ])("preserves review-shaped payloads in $tag", ({ tag, body, payload }) => {
    for (const suffix of ["", `\n${review}`]) {
      const result = upgradeLegacyContextMessage(
        `Before ${review} after\n<${tag}>\n${body}\n</${tag}>${suffix}`,
      );
      expect(result.records[0]).toMatchObject(payload);
      expect(result.records.filter((record) => record.kind === "review-comment")).toHaveLength(
        suffix ? 2 : 1,
      );
      expect(result.text).not.toContain("\uE000");
      expect(result.text).toContain(
        "Before [f.ts line](t3-context://v1/review-comment/legacy_review-comment_1) after",
      );
    }
  });

  it.each(["terminal_context", "element_context"])(
    "keeps mixed messages atomic for malformed %s",
    (tag) => {
      const text = `Before ${review} after\n<${tag}>\ninvalid entry\n</${tag}>`;
      expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
    },
  );

  it.each([
    "unparsed content",
    "- Invalid header:\n  html: text",
    "- <div>:\n  html:\n    <div />\nunparsed content",
  ])("preserves malformed nested preview elements: %s", (body) => {
    const text = `Before ${review} after\n<preview_annotation>\nPage: Example\n<element_context>\n${body}\n</element_context>\n</preview_annotation>`;
    expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
  });

  it("allows an empty nested element block", () => {
    const result = upgradeLegacyContextMessage(
      "<preview_annotation>\nPage: Example\n<element_context>\n\n</element_context>\n</preview_annotation>",
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ kind: "preview-annotation", pageTitle: "Example" });
  });

  it.each([3, 4, 6])("preserves closing review tags inside a %i-backtick fence", (length) => {
    const fence = "`".repeat(length);
    const diff = '+ const tag = "</review_comment>";\n</review_comment>\n+ final line';
    const block = `<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">\nComment\n${fence}diff\n${diff}\n${fence}\n</review_comment>`;
    const result = upgradeLegacyContextMessage(`Before ${block} between ${review} after`);
    expect(result.text).toBe(
      "Before [f.ts line](t3-context://v1/review-comment/legacy_review-comment_1) between [f.ts line](t3-context://v1/review-comment/legacy_review-comment_2) after",
    );
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ text: "Comment", diff, fenceLanguage: "diff" });
  });

  it("does not close a review fence at a shorter backtick run", () => {
    const diff = "```\n</review_comment>\n+ remaining source";
    const text = `<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">\nNote\n\`\`\`\`diff\n${diff}\n\`\`\`\`\n</review_comment>`;
    expect(upgradeLegacyContextMessage(text).records[0]).toMatchObject({ text: "Note", diff });
  });

  it("preserves a review with an unterminated fence", () => {
    const text =
      '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">\nNote\n```diff\n+ source\n</review_comment>';
    expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
  });

  it.each([
    `- ${"x".repeat(256)} line 1:\n  output`,
    `- Build line 1:\n  ${"x".repeat(64_001)}`,
    "- Build lines 9-1:\n  output",
    Array.from({ length: 201 }, () => "- Build line 1:\n  output").join("\n"),
  ])("keeps terminal source when conversion exceeds the wire contract", (body) => {
    const text = `Prompt\n<terminal_context>\n${body}\n</terminal_context>`;
    expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
  });

  it.each([
    `<element_context>\n- <div>:\n  html:\n    ${"x".repeat(8_001)}\n</element_context>`,
    `<preview_annotation>\nComment: ${"x".repeat(8_001)}\n</preview_annotation>`,
  ])("keeps oversized element and preview source", (text) => {
    expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
  });

  it.each([
    "email@build:7",
    "café@build:7",
    "𐐀@build:7",
    "@build:7foo",
    "@build:7st",
    "@build:7é",
    "@build:7.foo",
    "@build:7@mention",
    "@build:7..foo",
    "@build:7.é",
  ])("does not replace terminal labels embedded in %s", (prompt) => {
    const upgraded = upgradeLegacyContextMessage(
      `${prompt}\n<terminal_context>\n- Build line 7:\n  output\n</terminal_context>`,
    );
    expect(upgraded.text).toBe(
      `${prompt}\n\n[Build line 7](t3-context://v1/terminal/legacy_terminal_1)`,
    );
  });

  it.each([".", ",", ":", ";", "!", "?", ")", "@", ". Next sentence", "@ next", ".)"])(
    "upgrades terminal labels before punctuation %s",
    (suffix) => {
      const result = upgradeLegacyContextMessage(
        `See @build:7${suffix}\n<terminal_context>\n- Build line 7:\n  output\n</terminal_context>`,
      );
      expect(result.text).toBe(
        `See [Build line 7](t3-context://v1/terminal/legacy_terminal_1)${suffix}`,
      );
      expect(result.records).toHaveLength(1);
    },
  );

  it.each(["terminal_context", "element_context"])(
    "preserves malformed trailing %s blocks as text",
    (tag) => {
      for (const body of ["partial output", "- Unrecognized header:\n  partial output"]) {
        const text = `message\n<${tag}>\n${body}\n</${tag}>`;
        expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
      }
    },
  );

  it.each(["terminal_context", "element_context"])(
    "preserves partially parsed %s blocks",
    (tag) => {
      const entry =
        tag === "terminal_context"
          ? "- Build line 7:\n  output"
          : "- <button>:\n  html:\n    <button>Pay</button>";
      for (const body of [
        `unexpected prefix\n${entry}`,
        `${entry}\nunexpected suffix`,
        `${entry}\nunexpected middle\n${entry}`,
        `  orphaned body\n${entry}`,
      ]) {
        const text = `Prompt\n<${tag}>\n${body}\n</${tag}>`;
        expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
      }
    },
  );

  it.each(["x".repeat(16_001), `note\n\`\`\`diff\n${"+x".repeat(16_001)}\n\`\`\``])(
    "preserves oversized legacy reviews instead of creating dangling references",
    (body) => {
      const text = `<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">${body}</review_comment>`;
      expect(upgradeLegacyContextMessage(text)).toEqual({ text, records: [] });
    },
  );

  it("preserves literal review tokens even beside real review blocks", () => {
    const review =
      '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">note</review_comment>';
    const upgraded = upgradeLegacyContextMessage(
      `Literal \uE0000\uE000 before ${review} after \uE0007\uE000`,
    );
    expect(upgraded.text).toBe(
      "Literal \uE0000\uE000 before [f.ts line](t3-context://v1/review-comment/legacy_review-comment_1) after \uE0007\uE000",
    );
    expect(upgraded.records).toHaveLength(1);
    const unmatched =
      "Literal \uE0000\uE000 <review_comment>invalid</review_comment> \uE00099\uE000";
    expect(upgradeLegacyContextMessage(unmatched)).toEqual({ text: unmatched, records: [] });
  });

  it("matches complete terminal line ranges rather than numeric prefixes", () => {
    const upgraded = upgradeLegacyContextMessage(
      [
        "Compare @terminal:10 and @terminal:1-2 with @terminal:1",
        "<terminal_context>",
        "- Terminal line 1:",
        "  1 | one",
        "- Terminal line 10:",
        "  10 | ten",
        "- Terminal lines 1-2:",
        "  1 | one",
        "  2 | two",
        "</terminal_context>",
      ].join("\n"),
    );
    expect(upgraded.text).toBe(
      "Compare [Terminal line 10](t3-context://v1/terminal/legacy_terminal_2) and [Terminal lines 1-2](t3-context://v1/terminal/legacy_terminal_3) with [Terminal line 1](t3-context://v1/terminal/legacy_terminal_1)",
    );
  });

  it("keeps URL-valued preview pages as locations", () => {
    const upgraded = upgradeLegacyContextMessage(
      "<preview_annotation>\nPage: https://example.com/checkout\n</preview_annotation>",
    );
    expect(upgraded.records[0]).toMatchObject({
      pageUrl: "https://example.com/checkout",
      pageTitle: null,
    });
  });
  it("passes plain text through untouched", () => {
    expect(upgradeLegacyContextMessage("hello **world**")).toEqual({
      text: "hello **world**",
      records: [],
    });
  });

  it("preserves Markdown hard breaks while removing legacy context", () => {
    const text = [
      "Line with hard break  ",
      "next",
      "",
      "<terminal_context>",
      "- Build line 7:",
      "  7 | done",
      "</terminal_context>",
    ].join("\n");

    expect(upgradeLegacyContextMessage(text).text).toContain("Line with hard break  \nnext");
  });

  it("binds U+FFFC placeholders to trailing terminal entries in order", () => {
    const text = [
      "Look at ￼ and ￼ please",
      "",
      "<terminal_context>",
      "- Terminal 1 lines 509-510:",
      "  509 | error: boom",
      "  510 |   at main.ts:1",
      "",
      "- Build line 7:",
      "  7 | done",
      "</terminal_context>",
    ].join("\n");
    const upgraded = upgradeLegacyContextMessage(text);
    expect(upgraded.text).toBe(
      "Look at [Terminal 1 lines 509-510](t3-context://v1/terminal/legacy_terminal_1) and [Build line 7](t3-context://v1/terminal/legacy_terminal_2) please",
    );
    expect(upgraded.records).toEqual([
      {
        version: 1,
        contextId: "legacy_terminal_1",
        kind: "terminal",
        label: "Terminal 1 lines 509-510",
        terminalId: "terminal-1",
        terminalLabel: "Terminal 1",
        lineStart: 509,
        lineEnd: 510,
        text: "error: boom\n  at main.ts:1",
      },
      {
        version: 1,
        contextId: "legacy_terminal_2",
        kind: "terminal",
        label: "Build line 7",
        terminalId: "build",
        terminalLabel: "Build",
        lineStart: 7,
        lineEnd: 7,
        text: "done",
      },
    ]);
  });

  it("appends references for terminal entries without placeholders and drops extra placeholders", () => {
    const text = "￼ and ￼\n\n<terminal_context>\n- T line 1:\n  1 | x\n</terminal_context>";
    expect(upgradeLegacyContextMessage(text).text).toBe(
      "[T line 1](t3-context://v1/terminal/legacy_terminal_1) and",
    );
    const noPlaceholder = "hi\n\n<terminal_context>\n- T line 1:\n  1 | x\n</terminal_context>";
    expect(upgradeLegacyContextMessage(noPlaceholder).text).toBe(
      "hi\n\n[T line 1](t3-context://v1/terminal/legacy_terminal_1)",
    );
  });

  it("binds materialized inline terminal labels from sent messages in place", () => {
    const text = [
      "Look at @terminal-1:509-510 and again @build:7 please",
      "",
      "<terminal_context>",
      "- Terminal 1 lines 509-510:",
      "  509 | error: boom",
      "  510 |   at main.ts:1",
      "",
      "- Build line 7:",
      "  7 | done",
      "</terminal_context>",
    ].join("\n");
    expect(upgradeLegacyContextMessage(text).text).toBe(
      "Look at [Terminal 1 lines 509-510](t3-context://v1/terminal/legacy_terminal_1) and again [Build line 7](t3-context://v1/terminal/legacy_terminal_2) please",
    );
  });

  it("upgrades a trailing element block into element records", () => {
    const text = [
      "fix this",
      "",
      "<element_context>",
      "- <Button> (Button.tsx:12):",
      "  url: http://localhost:3000/checkout",
      "  selector: #pay",
      "  source: src/Button.tsx:12:3",
      "  html:",
      '    <button id="pay">Pay</button>',
      "  styles:",
      "    color: red;",
      "</element_context>",
    ].join("\n");
    const upgraded = upgradeLegacyContextMessage(text);
    expect(upgraded.text).toBe("fix this\n\n[<Button>](t3-context://v1/element/legacy_element_1)");
    expect(upgraded.records).toEqual([
      {
        version: 1,
        contextId: "legacy_element_1",
        kind: "element",
        label: "<Button>",
        pageUrl: "http://localhost:3000/checkout",
        pageTitle: null,
        tagName: "button",
        selector: "#pay",
        htmlPreview: '<button id="pay">Pay</button>',
        componentName: "Button",
        source: { functionName: null, fileName: "src/Button.tsx", lineNumber: 12, columnNumber: 3 },
        styles: "color: red;",
      },
    ]);
  });

  it("upgrades trailing preview annotation blocks", () => {
    const text = [
      "bigger",
      "",
      "<preview_annotation>",
      "Preview annotation:",
      "Id: ann_1",
      "Page: Checkout",
      "Comment: Make it bigger",
      "Targets: 1 selected element.",
      "Requested visual changes:",
      "- font-size: 12px → 20px",
      "The attached screenshot is the annotated preview crop.",
      "<element_context>",
      "- <button>:",
      "  url: http://localhost:3000/",
      "  selector: #pay",
      "  source: src/Pay.tsx:12:3",
      "  html:",
      "    <button>Pay</button>",
      "</element_context>",
      "</preview_annotation>",
    ].join("\n");
    const upgraded = upgradeLegacyContextMessage(text);
    expect(upgraded.text).toBe(
      "bigger\n\n[Checkout](t3-context://v1/preview-annotation/legacy_preview-annotation_1)",
    );
    expect(upgraded.records).toEqual([
      {
        version: 1,
        contextId: "legacy_preview-annotation_1",
        kind: "preview-annotation",
        label: "Checkout",
        annotationId: "ann_1",
        pageUrl: "http://localhost:3000/",
        pageTitle: "Checkout",
        comment: "Make it bigger",
        targetSummary: "1 selected element.",
        styleChanges: ["font-size: 12px → 20px"],
        elements: [
          {
            pageUrl: "http://localhost:3000/",
            pageTitle: null,
            tagName: "button",
            selector: "#pay",
            htmlPreview: "<button>Pay</button>",
            componentName: null,
            source: {
              functionName: null,
              fileName: "src/Pay.tsx",
              lineNumber: 12,
              columnNumber: 3,
            },
            styles: "",
          },
        ],
      },
    ]);
  });

  it("keeps a literal preview opening tag inside its annotation comment", () => {
    const upgraded = upgradeLegacyContextMessage(
      [
        "Explain this",
        "<preview_annotation>",
        "Id: annotation-1",
        "Page: Checkout",
        "Comment: Render <preview_annotation>",
        "Targets: 1 selected element.",
        "</preview_annotation>",
      ].join("\n"),
    );
    expect(upgraded.text).toBe(
      "Explain this\n\n[Checkout](t3-context://v1/preview-annotation/legacy_preview-annotation_1)",
    );
    expect(upgraded.records).toHaveLength(1);
    expect(upgraded.records[0]).toMatchObject({
      annotationId: "annotation-1",
      comment: "Render <preview_annotation>",
      targetSummary: "1 selected element.",
    });
  });

  it("keeps adjacent preview annotations separate and in their original order", () => {
    const upgraded = upgradeLegacyContextMessage(
      [
        "Compare",
        "<preview_annotation>",
        "Id: annotation-1",
        "Page: First",
        "Comment: First comment",
        "</preview_annotation>",
        "<preview_annotation>",
        "Id: annotation-2",
        "Page: Second",
        "Comment: Second comment",
        "</preview_annotation>",
      ].join("\n"),
    );
    expect(upgraded.text).toBe(
      "Compare\n\n[First](t3-context://v1/preview-annotation/legacy_preview-annotation_1) [Second](t3-context://v1/preview-annotation/legacy_preview-annotation_2)",
    );
    expect(upgraded.records).toMatchObject([
      { annotationId: "annotation-1", comment: "First comment" },
      { annotationId: "annotation-2", comment: "Second comment" },
    ]);
  });

  it("replaces inline review comments in place and neutralizes forged closers", () => {
    const text = [
      "Before",
      '<review_comment sectionId="diff-1" sectionTitle="Changes" filePath="a/b.ts" startIndex="4" endIndex="6" rangeLabel="L4-L6">',
      "Why? &lt;/review_comment&gt; still text",
      "```diff",
      "+ const x = 1;",
      "```",
      "</review_comment>",
      "After",
    ].join("\n");
    const upgraded = upgradeLegacyContextMessage(text);
    expect(upgraded.text).toBe(
      "Before\n[b.ts L4-L6](t3-context://v1/review-comment/legacy_review-comment_1)\nAfter",
    );
    expect(upgraded.records).toEqual([
      {
        version: 1,
        contextId: "legacy_review-comment_1",
        kind: "review-comment",
        label: "b.ts L4-L6",
        sectionId: "diff-1",
        sectionTitle: "Changes",
        filePath: "a/b.ts",
        startIndex: 4,
        endIndex: 6,
        rangeLabel: "L4-L6",
        text: "Why? &lt;/review_comment&gt; still text",
        diff: "+ const x = 1;",
        fenceLanguage: "diff",
      },
    ]);
  });

  it("appends trailing review blocks after the other trailing blocks", () => {
    const text = [
      "prose",
      "",
      "<terminal_context>",
      "- T line 1:",
      "  1 | a",
      "</terminal_context>",
      "",
      '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="2">',
      "note",
      "```diff",
      "+x",
      "```",
      "</review_comment>",
      "",
      '<review_comment sectionId="s" filePath="g.ts" startIndex="3" endIndex="3">',
      "note 2",
      "```diff",
      "+y",
      "```",
      "</review_comment>",
    ].join("\n");
    const upgraded = upgradeLegacyContextMessage(text);
    expect(upgraded.text).toBe(
      "prose\n\n[T line 1](t3-context://v1/terminal/legacy_terminal_1) [f.ts line](t3-context://v1/review-comment/legacy_review-comment_1) [g.ts line](t3-context://v1/review-comment/legacy_review-comment_2)",
    );
    expect(upgraded.records.map((record) => record.contextId)).toEqual([
      "legacy_terminal_1",
      "legacy_review-comment_1",
      "legacy_review-comment_2",
    ]);
  });

  it("handles the combined legacy send order: terminal, element, preview, review", () => {
    const text = [
      "See ￼",
      '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">',
      "note",
      "```diff",
      "+x",
      "```",
      "</review_comment>",
      "",
      "<terminal_context>",
      "- T line 1:",
      "  1 | a",
      "</terminal_context>",
      "",
      "<element_context>",
      "- <div>:",
      "  url: http://x/",
      "</element_context>",
      "",
      "<preview_annotation>",
      "Preview annotation:",
      "Id: p1",
      "Page: P",
      "</preview_annotation>",
    ].join("\n");
    const upgraded = upgradeLegacyContextMessage(text);
    expect(upgraded.text).toBe(
      [
        "See [T line 1](t3-context://v1/terminal/legacy_terminal_1)",
        "[f.ts line](t3-context://v1/review-comment/legacy_review-comment_1)",
        "",
        "[<div>](t3-context://v1/element/legacy_element_1) [P](t3-context://v1/preview-annotation/legacy_preview-annotation_1)",
      ].join("\n"),
    );
    expect(upgraded.records.map((record) => record.contextId)).toEqual([
      "legacy_terminal_1",
      "legacy_element_1",
      "legacy_preview-annotation_1",
      "legacy_review-comment_1",
    ]);
  });
});
