import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves windows drive roots in display paths", () => {
    expect(formatWorkspaceRelativePath("C:/Users/mike/file.ts", "C:/")).toBe(
      "C:/Users/mike/file.ts",
    );
    expect(formatWorkspaceRelativePath("C:\\Users\\mike\\file.ts", "C:\\")).toBe(
      "C:/Users/mike/file.ts",
    );
  });

  it("preserves filesystem roots when formatting the root itself", () => {
    expect(formatWorkspaceRelativePath("C:/", "C:/")).toBe("C:/");
    expect(formatWorkspaceRelativePath("/", "/")).toBe("/");
    expect(formatWorkspaceRelativePath("/usr/bin/tool", "/")).toBe("/usr/bin/tool");
  });

  it("formats files from a UNC share root", () => {
    expect(formatWorkspaceRelativePath("\\\\SERVER\\Share\\file.ts", "\\\\server\\share\\")).toBe(
      "share/file.ts",
    );
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });

  it("does not format a case-distinct posix sibling as workspace-relative", () => {
    expect(
      formatWorkspaceRelativePath(
        "/tmp/t3code-case-test/project/probe.txt",
        "/tmp/t3code-case-test/Project",
      ),
    ).toBe("/tmp/t3code-case-test/project/probe.txt");
  });

  it("formats exact-case posix workspace paths as workspace-relative", () => {
    expect(
      formatWorkspaceRelativePath(
        "/Users/mike/Project/src/session-logic.ts",
        "/Users/mike/Project",
      ),
    ).toBe("Project/src/session-logic.ts");
  });

  it("keeps windows workspace formatting case-insensitive", () => {
    expect(
      formatWorkspaceRelativePath(
        "c:/users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts",
        "C:/Users/Mike/Dev-Stuff/T3Code",
      ),
    ).toBe("T3Code/apps/web/src/session-logic.ts");
  });
});
