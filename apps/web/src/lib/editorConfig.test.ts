import { describe, expect, it } from "vite-plus/test";

import {
  editorConfigCandidates,
  editorConfigQueryPath,
  parseEditorConfig,
  resolveEditorConfigTabWidth,
} from "./editorConfig";

function width(contents: string, relativePath = "src/index.ts") {
  return resolveEditorConfigTabWidth([{ config: parseEditorConfig(contents), relativePath }]);
}

describe("EditorConfig tab width", () => {
  it("uses tab_width before indent_size and otherwise preserves the two-column default", () => {
    expect(width("[*]\nindent_size = 4\ntab_width = 8")).toBe(8);
    expect(width("[*]\nindent_size = 4")).toBe(4);
    expect(width("[*]\nindent_size = tab")).toBe(2);
    expect(width("[*]\nindent_style = tab")).toBe(2);
    expect(width("# No settings")).toBe(2);
  });

  it("applies matching sections in order, inheriting properties rather than whole sections", () => {
    const config = "root = true\n[*]\nindent_size = 4\ntab_width = 4\n[*.md]\nindent_size = 2";
    expect(width(config)).toBe(4);
    // indent_size does not clear a tab_width inherited from an earlier matching section.
    expect(width(config, "docs/guide.md")).toBe(4);
    expect(width(`${config}\ntab_width = unset`, "docs/guide.md")).toBe(2);
  });

  it("merges parent configurations before nearer ones and supports unset", () => {
    const parent = {
      config: parseEditorConfig("[*]\nindent_size = 4\ntab_width = 8"),
      relativePath: "src/a.ts",
    };
    const child = {
      config: parseEditorConfig("[*.ts]\ntab_width = unset\nindent_size = 6"),
      relativePath: "a.ts",
    };
    expect(resolveEditorConfigTabWidth([child, parent])).toBe(6);
    expect(
      resolveEditorConfigTabWidth([
        { ...child, config: parseEditorConfig("[*.ts]\nindent_size = 3") },
        parent,
      ]),
    ).toBe(8);
  });

  it.each(["0", "-1", "1.5", "4px", "NaN", "4 # comment", "9007199254740992"])(
    "ignores unsupported tab_width %s",
    (value) => {
      expect(width(`[*]\ntab_width = ${value}\nindent_size = 3`)).toBe(3);
    },
  );

  it("handles CRLF, BOM, case-insensitive pairs and preamble-only root", () => {
    const config = parseEditorConfig(
      "\uFEFFROOT = TRUE\r\n; comment\r\n[*]\r\nTAB_WIDTH = 4\r\nroot = false",
    );
    expect(config.root).toBe(true);
    expect(resolveEditorConfigTabWidth([{ config, relativePath: ".hidden" }])).toBe(4);
    expect(parseEditorConfig("[*]\nroot = true").root).toBe(false);
  });

  it.each([
    ["*.ts", "nested/file.ts", true],
    ["/file.ts", "nested/file.ts", false],
    ["/file.ts", "file.ts", true],
    ["src/*.ts", "src/nested/file.ts", false],
    ["src/**/*.ts", "src/nested/file.ts", true],
    ["src/a**z.ts", "src/abc/nested/z.ts", true],
    ["src/a**z.ts", "src/az.ts", true],
    ["*.{ts,tsx}", "src/view.tsx", true],
    ["file{1..3}.ts", "file2.ts", true],
    ["file{1..3}.ts", "file4.ts", false],
    ["file{01..03}.ts", "file02.ts", true],
    ["file{01..03}.ts", "file2.ts", false],
    ["file{-03..02}.ts", "file-02.ts", true],
    ["file{-03..02}.ts", "file002.ts", true],
    ["file{000001..1000000}.ts", "file0999999.ts", true],
    ["[a/]foo.ts", "nested/afoo.ts", true],
    ["[a/]foo.ts", "nested/bfoo.ts", false],
    ["src/[a/]foo.ts", "src/afoo.ts", true],
    ["src/[a/]foo.ts", "nested/src/afoo.ts", false],
    ["/src[/]foo.ts", "src/foo.ts", true],
    ["/src[/]foo.ts", "nested/src/foo.ts", false],
    ["[!a/]foo.ts", "nested/bfoo.ts", true],
    ["[!a/]foo.ts", "nested/afoo.ts", false],
    ["[a\\/]foo.ts", "nested/afoo.ts", true],
    ["[\\d/]foo.ts", "nested/dfoo.ts", true],
    ["[\\d/]foo.ts", "nested/5foo.ts", false],
    ["[\\!a/]foo.ts", "nested/!foo.ts", true],
    ["[\\!a/]foo.ts", "nested/bfoo.ts", false],
    ["[/-9]foo.ts", "nested/5foo.ts", false],
    ["[/-9]foo.ts", "nested/-foo.ts", true],
    ["[a-z/]foo.ts", "nested/mfoo.ts", false],
    ["[a-z/]foo.ts", "nested/zfoo.ts", true],
    ["file[0-9].ts", "nested/file5.ts", false],
    ["file[0-9].ts", "nested/file0.ts", true],
    ["file[0-9].ts", "nested/file-.ts", true],
    ["file[0-9].ts", "nested/file9.ts", true],
    ["file[!0-9].ts", "nested/file5.ts", true],
    ["file[!0-9].ts", "nested/file0.ts", false],
    ["file[!0-9].ts", "nested/file-.ts", false],
    ["file[!0-9].ts", "nested/file9.ts", false],
    ["file[^a].ts", "nested/file^.ts", true],
    ["file[^a].ts", "nested/filea.ts", true],
    ["file[^a].ts", "nested/fileb.ts", false],
    ["file[!^a].ts", "nested/file^.ts", false],
    ["file[!^a].ts", "nested/fileb.ts", true],
    ["file[ab*c{1..2}].ts", "nested/file*.ts", true],
    ["file[ab*c{1..2}].ts", "nested/file{.ts", true],
    ["file[ab*c{1..2}].ts", "nested/file..ts", true],
    ["file[ab*c{1..2}].ts", "nested/file3.ts", false],
    ["file[!ab*c{1..2}].ts", "nested/file*.ts", false],
    ["file[!ab*c{1..2}].ts", "nested/file3.ts", true],
    ["file[\\]a].ts", "nested/file].ts", true],
    ["file[\\!a].ts", "nested/file!.ts", true],
    ["file[\\!a].ts", "nested/fileb.ts", false],
    ["file[[a].ts", "nested/file[.ts", true],
    ["file[\\\\a].ts", "nested/file\\.ts", true],
    ["file[0-9]{1..3}.ts", "file52.ts", false],
    ["file[0-9]{1..3}.ts", "file-2.ts", true],
    ["file{1..1000000}.ts", "nested/file999999.ts", true],
    ["file{1..1000000}.ts", "file1000000.ts", true],
    ["file{1..1000000}.ts", "file1000001.ts", false],
    ["file{1..1000000}.ts", "file0.ts", false],
    ["src/a**file{1..1000000}.ts", "src/a/nested/file999999.ts", true],
    ["a**file{1..3}.ts", "a/nested/file2.ts", true],
    ["a**file{1..3}.ts", "other/a/nested/file2.ts", true],
    ["a**file{1..3}.ts", "other/afile2.ts", true],
    ["a**file{1..3}.ts", "a/nested/file4.ts", false],
    ["**/file{1..3}.ts", "file2.ts", true],
    ["src/**/file{1..3}.ts", "src/file2.ts", true],
    ["src/**/file{1..3}.ts", "src/a/b/file2.ts", true],
    ["a**/file{1..3}.ts", "afile2.ts", false],
    ["file{-1000000..3}.ts", "file-999999.ts", true],
    ["file{-1000000..3}.ts", "file-1000001.ts", false],
    ["file{-1000000..3}.ts", "file0.ts", true],
    ["file{-1000000..3}.ts", "file4.ts", false],
    ["file{-1000000..-2}.ts", "file-2.ts", true],
    ["file{-1000000..-2}.ts", "file-1.ts", false],
    ["file{1..1000000}{1..3}.ts", "file9999992.ts", true],
    ["file{1..100}{200..300}.ts", "file1200.ts", true],
    ["file{1..100}{200..300}.ts", "file1199.ts", false],
    ["file*{20..30}.ts", "file12325.ts", true],
    ["file*{20..30}.ts", "file12319.ts", false],
    ["file\\*{1..3}.ts", "file*2.ts", true],
    ["file\\*{1..3}.ts", "filex2.ts", false],
    ["file?{1..3}.ts", "filex2.ts", true],
    ["file?{1..3}.ts", "file/x2.ts", false],
    ["file[!a]{1..3}.ts", "fileb2.ts", true],
    ["file[!a]{1..3}.ts", "filea2.ts", false],
    ["{file{1..1000000},other}.ts", "other.ts", true],
    ["{file{1..1000000},other}.ts", "file999999.ts", true],
    ["file\\{1..1000000\\}.ts", "file{1..1000000}.ts", true],
    ["\\[a/\\]foo.ts", "[a/]foo.ts", true],
    ["EDITORCONFIGTOKEN{1..1000000}.ts", "EDITORCONFIGTOKEN999999.ts", true],
    ["[{1..1000000}/].ts", "nested/1.ts", true],
    ["[!a].ts", "b.ts", true],
    ["*.ts", ".hidden.ts", true],
    ["!special.ts", "!special.ts", true],
    ["file\\?.ts", "file?.ts", true],
  ])("matches [%s] against %s: %s", (pattern, path, matches) => {
    expect(width(`[${pattern}]\ntab_width = 4`, path)).toBe(matches ? 4 : 2);
  });

  it("matches very large integer bounds without expanding every number", () => {
    const config = parseEditorConfig("[file{1..100000000000000000000}.ts]\ntab_width = 4");
    expect(
      resolveEditorConfigTabWidth([{ config, relativePath: "file99999999999999999999.ts" }]),
    ).toBe(4);
    expect(
      resolveEditorConfigTabWidth([{ config, relativePath: "file100000000000000000001.ts" }]),
    ).toBe(2);
  });

  it("keeps valid 900-digit bounds as data rather than compiling their decimal expansion", () => {
    const upper = `1${"0".repeat(900)}`;
    const config = parseEditorConfig(`[file{1..${upper}}.ts]\ntab_width = 4`);
    for (const filename of ["file2.ts", `file${upper}.ts`]) {
      expect(resolveEditorConfigTabWidth([{ config, relativePath: filename }])).toBe(4);
    }
    expect(
      resolveEditorConfigTabWidth([{ config, relativePath: `file2${"0".repeat(900)}.ts` }]),
    ).toBe(2);
    const negative = parseEditorConfig(`[file{-${upper}..-1}.ts]\ntab_width = 4`);
    expect(
      resolveEditorConfigTabWidth([{ config: negative, relativePath: "file-999999.ts" }]),
    ).toBe(4);
    expect(resolveEditorConfigTabWidth([{ config: negative, relativePath: "file0.ts" }])).toBe(2);
  });

  it("handles a one-megabyte numeric bound without expanding values or generating a numeric regex", () => {
    const upper = `1${"0".repeat(1_000_000)}`;
    const config = parseEditorConfig(`[file{1..${upper}}.ts]\ntab_width = 4`);
    expect(resolveEditorConfigTabWidth([{ config, relativePath: "file2.ts" }])).toBe(4);
    for (const filename of ["file0.ts", "file-2.ts", "file2x.ts"]) {
      expect(resolveEditorConfigTabWidth([{ config, relativePath: filename }])).toBe(2);
    }
  });

  it("repartitions adjacent ranges without exponential backtracking on an unmatched suffix", () => {
    const config = parseEditorConfig(`[file${"{1..1000000}".repeat(10)}.ts]\ntab_width = 4`);
    const filename = `file${"1".repeat(40)}`;
    expect(resolveEditorConfigTabWidth([{ config, relativePath: `${filename}.ts` }])).toBe(4);
    expect(resolveEditorConfigTabWidth([{ config, relativePath: `${filename}.txt` }])).toBe(2);
  });

  it.each([
    [17, 234],
    [-234, -17],
    [-17, 234],
  ])("matches every integer inside %s..%s and excludes nearby integers", (min, max) => {
    const config = parseEditorConfig(`[file{${min}..${max}}.ts]\ntab_width = 4`);
    for (let value = -250; value <= 250; value++) {
      expect(resolveEditorConfigTabWidth([{ config, relativePath: `file${value}.ts` }])).toBe(
        value >= min && value <= max ? 4 : 2,
      );
    }
  });
});

describe("EditorConfig lookup paths", () => {
  it.each([
    ["/repo", "/repo/.editorconfig", ".editorconfig"],
    ["/repo/", "/repo/src/.editorconfig", "src/.editorconfig"],
    ["/repo", "/.editorconfig", "/.editorconfig"],
    ["/repo", "/repo-other/.editorconfig", "/repo-other/.editorconfig"],
    ["/", "/.editorconfig", ".editorconfig"],
    ["C:\\repo", "C:/repo/src/.editorconfig", "src/.editorconfig"],
    ["C:\\REPO\\", "c:/repo/.editorconfig", ".editorconfig"],
    ["C:\\repo", "C:/.editorconfig", "C:/.editorconfig"],
    ["\\\\host\\share\\repo", "//host/share/repo/.editorconfig", ".editorconfig"],
    ["\\\\host\\share\\repo", "//host/share/.editorconfig", "//host/share/.editorconfig"],
    ["//HOST/share/REPO", "//host/share/repo/src/.editorconfig", "src/.editorconfig"],
    ["//host/share/repo", "//host/share/.editorconfig", "//host/share/.editorconfig"],
    ["//host/share", "//host/share/.editorconfig", ".editorconfig"],
  ])("shares the save query key for %s and %s", (cwd, configPath, expected) => {
    expect(editorConfigQueryPath(cwd, configPath)).toBe(expected);
  });

  it("searches from the file directory through parents above the workspace", () => {
    expect(editorConfigCandidates("/repo", "src/file.ts")).toEqual([
      { configPath: "/repo/src/.editorconfig", relativePath: "file.ts" },
      { configPath: "/repo/.editorconfig", relativePath: "src/file.ts" },
      { configPath: "/.editorconfig", relativePath: "repo/src/file.ts" },
    ]);
  });

  it("normalizes Windows separators and stops at the drive or UNC share root", () => {
    expect(
      editorConfigCandidates("C:\\repo", "src\\file.ts").map((candidate) => candidate.configPath),
    ).toEqual(["C:/repo/src/.editorconfig", "C:/repo/.editorconfig", "C:/.editorconfig"]);
    expect(
      editorConfigCandidates("\\\\host\\share\\repo", "file.ts").map(
        (candidate) => candidate.configPath,
      ),
    ).toEqual(["//host/share/repo/.editorconfig", "//host/share/.editorconfig"]);
  });

  it("resolves absolute host files and normalizes dot segments without changing Unix backslashes", () => {
    expect(editorConfigCandidates("/repo", "/tmp/file.ts")[0]).toEqual({
      configPath: "/tmp/.editorconfig",
      relativePath: "file.ts",
    });
    expect(editorConfigCandidates("/repo", "./src/../file.ts")[0]).toEqual({
      configPath: "/repo/.editorconfig",
      relativePath: "file.ts",
    });
    expect(editorConfigCandidates("/repo", "literal\\file.ts")[0]?.relativePath).toBe(
      "literal\\file.ts",
    );
  });

  it.each(["//host/share/repo", "\\\\host\\share\\repo"])(
    "preserves the network share root for %s and absolute Git paths",
    (cwd) => {
      for (const file of ["src/file.ts", "//host/share/repo/src/file.ts"]) {
        expect(editorConfigCandidates(cwd, file)).toEqual([
          { configPath: "//host/share/repo/src/.editorconfig", relativePath: "file.ts" },
          { configPath: "//host/share/repo/.editorconfig", relativePath: "src/file.ts" },
          { configPath: "//host/share/.editorconfig", relativePath: "repo/src/file.ts" },
        ]);
      }
      expect(editorConfigCandidates(cwd, "../../../../file.ts")).toEqual([
        { configPath: "//host/share/.editorconfig", relativePath: "file.ts" },
      ]);
    },
  );
});
