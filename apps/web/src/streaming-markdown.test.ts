import { describe, expect, it } from "vitest";

import { finalizeStreamingMarkdown } from "./streaming-markdown";

describe("finalizeStreamingMarkdown", () => {
  it("closes unfinished bold markers while streaming", () => {
    expect(finalizeStreamingMarkdown("I just love **bold text")).toBe("I just love **bold text**");
  });

  it("closes unfinished inline code spans", () => {
    expect(finalizeStreamingMarkdown("Use `bun fmt")).toBe("Use `bun fmt`");
  });

  it("closes unfinished fenced code blocks", () => {
    expect(finalizeStreamingMarkdown("```ts\nconst value = 1;")).toBe(
      "```ts\nconst value = 1;\n```",
    );
  });

  it("preserves completed markdown without adding extra delimiters", () => {
    expect(finalizeStreamingMarkdown("Already **done** and `closed`")).toBe(
      "Already **done** and `closed`",
    );
  });

  it("does not treat intraword underscores as emphasis", () => {
    expect(finalizeStreamingMarkdown("snake_case and __bold")).toBe("snake_case and __bold__");
  });

  it("closes nested emphasis in reverse order", () => {
    expect(finalizeStreamingMarkdown("**bold *italic")).toBe("**bold *italic***");
  });

  it("closes unfinished inline markdown links", () => {
    expect(finalizeStreamingMarkdown("See [docs](https://example.com/path")).toBe(
      "See [docs](https://example.com/path)",
    );
  });

  it("closes nested parentheses inside unfinished link destinations", () => {
    expect(finalizeStreamingMarkdown("See [docs](https://example.com/path(foo")).toBe(
      "See [docs](https://example.com/path(foo))",
    );
  });

  it("ignores link-like syntax inside inline code", () => {
    expect(finalizeStreamingMarkdown("Use `[docs](https://example.com`")).toBe(
      "Use `[docs](https://example.com`",
    );
  });

  it("closes unfinished strikethrough markers", () => {
    expect(finalizeStreamingMarkdown("This is ~~important")).toBe("This is ~~important~~");
  });

  it("closes unfinished autolinks", () => {
    expect(finalizeStreamingMarkdown("Visit <https://example.com/path")).toBe(
      "Visit <https://example.com/path>",
    );
  });

  it("does not keep autolinks open across whitespace", () => {
    expect(finalizeStreamingMarkdown("Visit <https://example.com path")).toBe(
      "Visit <https://example.com path",
    );
  });
});
