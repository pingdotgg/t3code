import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("labels only relative paths, not Windows paths outside the workspace", () => {
    const workspaceRoot = "C:\\Users\\mike\\dev-stuff\\t3code";
    expect(
      formatWorkspaceRelativePath("C:\\Users\\mike\\.claude\\settings.json:3", workspaceRoot),
    ).toBe("C:/Users/mike/.claude/settings.json:3");
    expect(formatWorkspaceRelativePath("D:/data/report.csv", workspaceRoot)).toBe(
      "D:/data/report.csv",
    );
    expect(formatWorkspaceRelativePath("src/app.ts", workspaceRoot)).toBe("t3code/src/app.ts");
  });

  it("keeps home paths as written instead of labelling them as workspace paths", () => {
    expect(formatWorkspaceRelativePath("~/.claude/CLAUDE.md", "/workspace/t3code")).toBe(
      "~/.claude/CLAUDE.md",
    );
    expect(formatWorkspaceRelativePath("~\\.claude\\CLAUDE.md:3", "C:\\dev\\t3code")).toBe(
      "~/.claude/CLAUDE.md:3",
    );
  });
});
