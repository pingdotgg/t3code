import { ComposerContextId, type ComposerContextRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import { formatComposerContextReference } from "./composerContextReferences.ts";
import { serializeLegacyContextMessage } from "./composerContextLegacySend.ts";

const terminal = {
  version: 1,
  contextId: ComposerContextId.make("terminal_t1"),
  kind: "terminal",
  label: "Terminal 1 lines 3-4",
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
  text: "boom\nagain",
} satisfies ComposerContextRecord;

const review = {
  version: 1,
  contextId: ComposerContextId.make("review-comment_rc1"),
  kind: "review-comment",
  label: "b.ts L4",
  sectionId: "file:a/b.ts",
  sectionTitle: "File comment",
  filePath: "a/b.ts",
  startIndex: 3,
  endIndex: 3,
  rangeLabel: "L4",
  text: "Why this branch?",
  diff: "const x = 1;",
  fenceLanguage: "ts",
} satisfies ComposerContextRecord;

const annotation = {
  version: 1,
  contextId: ComposerContextId.make("preview-annotation_ann1"),
  kind: "preview-annotation",
  label: "Fix the checkout button",
  annotationId: "ann1",
  pageUrl: "https://example.com/checkout",
  pageTitle: "Checkout",
  comment: "Make this button clearer",
  targetSummary: "1 selected element",
  styleChanges: ["color: red → blue"],
  elements: [
    {
      pageUrl: "https://example.com/checkout",
      pageTitle: "Checkout",
      tagName: "button",
      selector: "#submit-order",
      htmlPreview: '<button id="submit-order">Buy now</button>',
      componentName: "SubmitOrderButton",
      source: {
        functionName: "SubmitOrderButton",
        fileName: "src/Checkout.tsx",
        lineNumber: 42,
        columnNumber: 7,
      },
      styles: "color: red;",
    },
  ],
} satisfies ComposerContextRecord;

describe("serializeLegacyContextMessage", () => {
  it("carries terminal payloads an older server would otherwise discard", () => {
    const text = `Look at ${formatComposerContextReference(terminal)} please`;
    const legacy = serializeLegacyContextMessage({ text, records: [terminal] });

    // An older server forwards text verbatim, so the payload has to be in it.
    expect(legacy).not.toContain("t3-context://");
    expect(legacy).toContain("boom");

    // A newer client reading that message reconstructs the same excerpt.
    const upgraded = upgradeLegacyContextMessage(legacy);
    expect(upgraded.records).toHaveLength(1);
    expect(upgraded.records[0]).toMatchObject({
      kind: "terminal",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "boom\nagain",
    });
  });

  it("inlines a review comment with its diff intact", () => {
    const text = `See ${formatComposerContextReference(review)} here`;
    const legacy = serializeLegacyContextMessage({ text, records: [review] });
    expect(legacy).not.toContain("t3-context://");

    const upgraded = upgradeLegacyContextMessage(legacy);
    expect(upgraded.records[0]).toMatchObject({
      kind: "review-comment",
      filePath: "a/b.ts",
      rangeLabel: "L4",
      text: "Why this branch?",
      diff: "const x = 1;",
    });
  });

  it.each([" ", "\n", "\n\n"])(
    "preserves the separator between a skill and a trailing PR through an older server: %j",
    (separator) => {
      const pullRequest = {
        ...review,
        label: "#11440",
        sectionId: "pull-request:11440",
        sectionTitle: "Pull request",
        filePath: "PR #11440",
        rangeLabel: "summary",
        text: "Audit Mobile Photo Import",
        diff: "",
      };
      const text = `$pr-audit${separator}${formatComposerContextReference(pullRequest)}`;
      const upgraded = upgradeLegacyContextMessage(
        serializeLegacyContextMessage({ text, records: [pullRequest] }),
      );

      expect(upgraded.records).toHaveLength(1);
      expect(upgraded.text).toBe(
        `$pr-audit${separator}${formatComposerContextReference(upgraded.records[0]!)}`,
      );
    },
  );

  it("retains picked-element details for preview annotations sent through an older server", () => {
    const text = `Update ${formatComposerContextReference(annotation)}`;
    const upgraded = upgradeLegacyContextMessage(
      serializeLegacyContextMessage({ text, records: [annotation] }),
    );

    expect(upgraded.records[0]).toMatchObject({
      kind: "preview-annotation",
      pageUrl: "https://example.com/checkout",
      elements: [
        {
          selector: "#submit-order",
          htmlPreview: '<button id="submit-order">Buy now</button>',
          source: {
            fileName: "src/Checkout.tsx",
            lineNumber: 42,
            columnNumber: 7,
          },
        },
      ],
    });
  });

  it("keeps prose without context untouched", () => {
    expect(serializeLegacyContextMessage({ text: "just prose", records: [] })).toBe("just prose");
  });

  it("appends review comments the text never referenced", () => {
    const legacy = serializeLegacyContextMessage({ text: "just prose", records: [review] });

    expect(legacy).toContain("Why this branch?");
    const upgraded = upgradeLegacyContextMessage(legacy);
    expect(upgraded.records).toHaveLength(1);
    expect(upgraded.records[0]).toMatchObject({
      kind: "review-comment",
      filePath: "a/b.ts",
      text: "Why this branch?",
    });
  });

  it("numbers terminal output within the declared line range", () => {
    const ranged = {
      ...terminal,
      lineStart: 3,
      lineEnd: 4,
      text: "boom\nagain\n",
    };
    const legacy = serializeLegacyContextMessage({ text: "look", records: [ranged] });

    expect(legacy).toContain("3 | boom\n  4 | again");
    expect(legacy).not.toContain("5 |");
  });
});
