import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native-nitro-markdown", () => ({
  defaultHighlighter: (language: string, code: string) => [
    { text: `${language}:${code}`, type: "default" },
  ],
}));

import { highlightMarkdownCode } from "./markdownCodeHighlighter";

describe("highlightMarkdownCode", () => {
  it("highlights YAML keys and scalar values", () => {
    const source = [
      "full-access:",
      "  approvalPolicy: never",
      "  retries: 3",
      "  enabled: true",
      "  # managed remotely",
    ].join("\n");
    const tokens = highlightMarkdownCode("yaml", source);

    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "full-access", type: "type" },
        { text: "approvalPolicy", type: "type" },
        { text: "never", type: "string" },
        { text: "3", type: "number" },
        { text: "true", type: "keyword" },
        { text: "# managed remotely", type: "comment" },
      ]),
    );
  });

  it("supports the yml alias and quoted hashes", () => {
    const source = 'name: "value #1" # actual comment';
    const tokens = highlightMarkdownCode("yml", source);

    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens).toContainEqual({ text: '"value #1"', type: "string" });
    expect(tokens).toContainEqual({ text: "# actual comment", type: "comment" });
  });

  it("delegates other languages to Nitro", () => {
    const source = "const answer = 42;";
    expect(highlightMarkdownCode("ts", source)).toEqual([
      { text: `ts:${source}`, type: "default" },
    ]);
  });
});
