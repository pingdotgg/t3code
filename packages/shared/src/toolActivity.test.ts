import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it.each([
    { data: { rawInput: {}, input: { query: " cleanup " } }, detail: "cleanup" },
    {
      data: {
        rawInput: { query: " ", pattern: 42 },
        input: { searchTerm: null },
        item: { arguments: { pattern: " TODO " } },
      },
      detail: "TODO",
    },
    {
      data: {
        rawInput: { searchTerm: "raw" },
        input: { query: "input" },
        item: { arguments: { query: "item" } },
      },
      detail: "raw",
    },
    {
      data: { rawInput: { query: "query", pattern: "pattern", searchTerm: "term" } },
      detail: "query",
    },
  ])("uses the first valid search query ($detail)", ({ data, detail }) => {
    expect(deriveToolActivityPresentation({ title: "Grep", data })).toEqual({
      summary: "Searched files",
      detail,
    });
  });

  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
});
