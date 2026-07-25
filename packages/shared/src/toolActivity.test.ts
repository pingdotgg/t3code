import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        status: "completed",
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

  it("uses the progressive tense while the tool is still running", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        status: "inProgress",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Running command",
      detail: "bun run lint",
    });

    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        status: "inProgress",
        data: {
          kind: "edit",
          locations: [{ path: "/tmp/app.ts" }],
        },
      }),
    ).toEqual({
      summary: "Changing files",
      detail: "/tmp/app.ts",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        status: "completed",
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
        status: "completed",
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

  it("keeps distinct search summaries and preserves subtitles", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Grep",
        detail: "src/**/*.ts",
        data: { toolName: "Grep", input: { pattern: "TODO" } },
      }),
    ).toEqual({ summary: "Searched files", detail: "TODO" });

    expect(
      deriveToolActivityPresentation({
        itemType: "web_search",
        status: "completed",
        title: "Search the web",
        detail: "latest release notes",
        data: { input: { query: "latest release notes" } },
      }),
    ).toEqual({ summary: "Web search", detail: "latest release notes" });
  });
});
