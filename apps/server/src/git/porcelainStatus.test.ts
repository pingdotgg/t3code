import { describe, expect, it } from "vite-plus/test";

import {
  parsePorcelainStatus,
  unquoteGitPath,
  workingTreeStatusFromPorcelainXy,
} from "./porcelainStatus.ts";

describe("workingTreeStatusFromPorcelainXy", () => {
  it.each([
    { xy: "M.", renamed: false, status: "modified" },
    { xy: ".M", renamed: false, status: "modified" },
    { xy: "MM", renamed: false, status: "modified" },
    { xy: "A.", renamed: false, status: "added" },
    { xy: "AM", renamed: false, status: "added" },
    { xy: "AD", renamed: false, status: "deleted" },
    { xy: ".D", renamed: false, status: "deleted" },
    { xy: "R.", renamed: true, status: "renamed" },
    { xy: "RM", renamed: true, status: "renamed" },
    { xy: "C.", renamed: false, status: "renamed" },
    { xy: "T.", renamed: false, status: "modified" },
    { xy: "UU", renamed: false, status: "modified" },
  ] as const)("maps $xy (renamed=$renamed) to $status", ({ xy, renamed, status }) => {
    expect(workingTreeStatusFromPorcelainXy(xy, renamed)).toBe(status);
  });
});

describe("parsePorcelainStatus", () => {
  it("classifies untracked files and keeps a trailing slash on untracked dirs", () => {
    expect(parsePorcelainStatus("? src/new.ts")).toEqual({
      path: "src/new.ts",
      status: "untracked",
    });
    expect(parsePorcelainStatus("? src/new/")).toEqual({ path: "src/new/", status: "untracked" });
  });

  it("ignores ignored rows", () => {
    expect(parsePorcelainStatus("! dist/bundle.js")).toBeNull();
  });

  it("reads the destination path from a rename record", () => {
    expect(
      parsePorcelainStatus("2 RM N... 100644 100644 100644 abcd efgh R100 new.ts\told.ts"),
    ).toEqual({ path: "new.ts", status: "renamed" });
  });

  it("classifies ordinary changed and added rows", () => {
    expect(parsePorcelainStatus("1 M. N... 100644 100644 100644 abcd efgh\tREADME.md")).toEqual({
      path: "README.md",
      status: "modified",
    });
    expect(parsePorcelainStatus("1 A. N... 100644 100644 100644 abcd efgh\tadded.ts")).toEqual({
      path: "added.ts",
      status: "added",
    });
  });

  it("keeps spaces in unquoted porcelain-2 paths and unquotes C-style names", () => {
    expect(
      parsePorcelainStatus(
        "1 .M N... 100644 100644 100644 bd4269ff9d6818e647e89bacacf357bc8b8eb33c bd4269ff9d6818e647e89bacacf357bc8b8eb33c my file.ts",
      ),
    ).toEqual({
      path: "my file.ts",
      status: "modified",
    });
    expect(parsePorcelainStatus('? "my file.ts"')).toEqual({
      path: "my file.ts",
      status: "untracked",
    });
    expect(
      parsePorcelainStatus('1 M. N... 100644 100644 100644 abcd efgh\t"src/my file.ts"'),
    ).toEqual({
      path: "src/my file.ts",
      status: "modified",
    });
    expect(
      parsePorcelainStatus(
        "2 R. N... 100644 100644 100644 abcd efgh R100 new file.ts\told file.ts",
      ),
    ).toEqual({ path: "new file.ts", status: "renamed" });
    expect(unquoteGitPath('"caf\\303\\251.ts"')).toBe("café.ts");
  });
});
