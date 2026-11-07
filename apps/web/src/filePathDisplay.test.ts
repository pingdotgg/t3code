import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("leaves Windows absolute paths outside the workspace alone", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:\\Users\\mike\\.claude\\settings.json:3",
        "C:\\Users\\mike\\dev-stuff\\t3code",
      ),
    ).toBe("C:/Users/mike/.claude/settings.json:3");
    expect(
      formatWorkspaceRelativePath("D:/data/report.csv", "C:/Users/mike/dev-stuff/t3code"),
    ).toBe("D:/data/report.csv");
  });

  it("still labels relative and in-workspace paths with the workspace name", () => {
    expect(formatWorkspaceRelativePath("src/app.ts", "C:/Users/mike/dev-stuff/t3code")).toBe(
      "t3code/src/app.ts",
    );
    expect(
      formatWorkspaceRelativePath(
        "c:\\users\\mike\\dev-stuff\\t3code\\src\\app.ts:7",
        "C:\\Users\\mike\\dev-stuff\\t3code",
      ),
    ).toBe("t3code/src/app.ts:7");
  });
});
