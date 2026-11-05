import { describe, expect, it } from "vite-plus/test";

import {
  externalLinkContextReferences,
  parseFigmaDesignUrl,
  parseGitHubIssueUrl,
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
    expect(
      parseFigmaDesignUrl("https://www.figma.com/design/AbCdEf123/Flow.v2?node-id=1-2"),
    ).toMatchObject({
      fileKey: "AbCdEf123",
      name: "Flow.v2",
      nodeId: "1:2",
    });
  });

  it("keeps trailing prose punctuation outside a Figma URL rewrite", () => {
    const rewritten = externalLinkContextReferences(
      "See https://www.figma.com/design/AbCdEf123/Flow?node-id=1-2).",
    );
    expect(rewritten.records).toHaveLength(1);
    expect(rewritten.records[0]).toMatchObject({ kind: "figma", nodeId: "1:2" });
    expect(rewritten.text.endsWith(").")).toBe(true);
    const withPeriod = externalLinkContextReferences(
      "See https://www.figma.com/design/AbCdEf123/Flow?node-id=1-2.",
    );
    expect(withPeriod.records[0]).toMatchObject({ kind: "figma", nodeId: "1:2" });
    expect(withPeriod.text.endsWith(".")).toBe(true);
    const dottedSlug = externalLinkContextReferences(
      "See https://www.figma.com/design/AbCdEf123/Flow.v2?node-id=1-2.",
    );
    expect(dottedSlug.records[0]).toMatchObject({ kind: "figma", name: "Flow.v2", nodeId: "1:2" });
    expect(dottedSlug.text.endsWith(".")).toBe(true);
  });

  it("keeps trailing prose punctuation outside a GitHub issue URL rewrite", () => {
    const rewritten = externalLinkContextReferences("(see https://github.com/acme/app/issues/7).");
    expect(rewritten.records).toHaveLength(1);
    expect(rewritten.records[0]).toMatchObject({ kind: "issue", number: 7 });
    expect(rewritten.text.endsWith(").")).toBe(true);
  });

  it("scopes Jira context ids by site host", () => {
    const rewritten = externalLinkContextReferences(
      "https://acme.atlassian.net/browse/APP-1 https://other.atlassian.net/browse/APP-1",
    );
    expect(rewritten.records).toHaveLength(2);
    expect(new Set(rewritten.records.map((record) => record.contextId)).size).toBe(2);
  });

  it("scopes GitHub issue context ids by host", () => {
    const rewritten = externalLinkContextReferences(
      "https://github.com/acme/app/issues/7 https://ghe.example.com/acme/app/issues/7",
    );
    expect(rewritten.records).toHaveLength(2);
    expect(new Set(rewritten.records.map((record) => record.contextId)).size).toBe(2);
  });

  it("rejects Figma URLs with malformed percent escapes", () => {
    expect(parseFigmaDesignUrl("https://www.figma.com/design/AbCdEf123/%")).toBeNull();
    expect(
      parseFigmaDesignUrl("https://www.figma.com/design/AbCdEf123/Checkout?node-id=%"),
    ).toBeNull();
    expect(
      externalLinkContextReferences("see https://www.figma.com/design/AbCdEf123/% here").text,
    ).toBe("see https://www.figma.com/design/AbCdEf123/% here");
  });

  it("parses GitHub issue URLs", () => {
    expect(parseGitHubIssueUrl("https://github.com/acme/app/issues/42")).toEqual({
      number: 42,
      title: "#42",
      url: "https://github.com/acme/app/issues/42",
      repository: "acme/app",
      state: "open",
    });
    expect(parseGitHubIssueUrl("https://acme.atlassian.net/browse/T3-42")).toBeNull();
  });

  it("rewrites pasted URLs into context references", () => {
    const rewritten = externalLinkContextReferences(
      "See https://acme.atlassian.net/browse/T3-42 and https://www.figma.com/design/AbCdEf123/Flow and https://github.com/acme/app/issues/7",
    );
    expect(rewritten.records.map((record) => record.kind)).toEqual(["jira", "figma", "issue"]);
    expect(rewritten.text).toContain("](https://acme.atlassian.net/browse/T3-42)");
    expect(rewritten.text).toContain("](https://www.figma.com/design/AbCdEf123)");
    expect(rewritten.text).toContain("](https://github.com/acme/app/issues/7)");
    expect(rewritten.text).not.toContain("t3-context://");
  });
});
