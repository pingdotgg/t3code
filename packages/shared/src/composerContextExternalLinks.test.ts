import { describe, expect, it } from "vite-plus/test";

import {
  externalLinkContextReferences,
  parseFigmaDesignUrl,
  parseJiraBrowseUrl,
} from "./composerContextExternalLinks.ts";

describe("composerContextExternalLinks", () => {
  it("parses Jira browse URLs", () => {
    expect(parseJiraBrowseUrl("https://acme.atlassian.net/browse/T3-42")).toEqual({
      key: "T3-42",
      url: "https://acme.atlassian.net/browse/T3-42",
    });
    expect(parseJiraBrowseUrl("https://example.com/browse/T3-42")).toBeNull();
  });

  it("parses Figma design URLs", () => {
    expect(
      parseFigmaDesignUrl("https://www.figma.com/design/AbCdEf123/Checkout?node-id=1-2"),
    ).toMatchObject({
      fileKey: "AbCdEf123",
      name: "Checkout",
      nodeId: "1:2",
    });
  });

  it("rewrites pasted URLs into context references", () => {
    const rewritten = externalLinkContextReferences(
      "See https://acme.atlassian.net/browse/T3-42 and https://www.figma.com/design/AbCdEf123/Flow",
    );
    expect(rewritten.records.map((record) => record.kind)).toEqual(["jira", "figma"]);
    expect(rewritten.text).toContain("](t3-context://v1/jira/");
    expect(rewritten.text).toContain("](t3-context://v1/figma/");
  });
});
