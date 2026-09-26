import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  collectToolFilePaths,
  deriveToolActivityPresentation,
  formatReadToolLabel,
  formatSearchToolLabel,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
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
      summary: "Read /tmp/app.ts",
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

  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("formats read and search labels from structured input", () => {
    expect(formatReadToolLabel("src/env.ts")).toBe("Read src/env.ts");
    expect(formatReadToolLabel("src/env.ts", 2)).toBe("Read src/env.ts +2 more");
    expect(formatReadToolLabel("")).toBe("Read file");
    expect(
      formatSearchToolLabel({
        input: { pattern: "TODO", path: "apps/web" },
      }),
    ).toBe("Searched TODO in web");
    expect(
      formatSearchToolLabel({
        input: { glob: "*.ts", path: "/tmp/t3chat-new" },
      }),
    ).toBe("Searched files *.ts in t3chat-new");
    expect(
      formatSearchToolLabel({ rawInput: {}, input: { pattern: "TODO", path: "apps/web" } }),
    ).toBe("Searched TODO in web");
    expect(formatSearchToolLabel({ input: { globPattern: "*.tsx", path: "apps/web" } })).toBe(
      "Searched files *.tsx in web",
    );
    expect(
      formatSearchToolLabel({ input: { pattern: "TODO", glob: "*.ts", path: "apps/web" } }),
    ).toBe("Searched TODO in web");
  });

  it("keeps bare filenames from explicit path fields", () => {
    expect(collectToolFilePaths({ input: { file_path: "README" } })).toEqual(["README"]);
  });

  it("keeps the first non-empty rawInput when a later update is empty", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { path: "src/a.ts", startLine: 4 } });
  });
});
