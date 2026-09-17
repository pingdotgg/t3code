import { describe, expect, it } from "vite-plus/test";

import { quoteGitPatchPath, unquoteGitPatchPath } from "./gitPatchPath.ts";

const BELL = "\u0007";
const UNIT_SEPARATOR = "\u001f";
const DELETE = "\u007f";

describe("quoteGitPatchPath", () => {
  it("leaves a name a header can carry as itself", () => {
    expect(quoteGitPatchPath("src/app.ts")).toBe("src/app.ts");
    expect(quoteGitPatchPath("with space.txt")).toBe("with space.txt");
    // Outside ASCII is only quoted for what a terminal can show, and a diff viewer is not one.
    expect(quoteGitPatchPath("café/résumé.ts")).toBe("café/résumé.ts");
    expect(quoteGitPatchPath("🚀.ts")).toBe("🚀.ts");
  });

  it("writes git's escape for a character the header would read as its own", () => {
    expect(quoteGitPatchPath("tab\tfile.txt")).toBe('"tab\\tfile.txt"');
    expect(quoteGitPatchPath("line\nfile.txt")).toBe('"line\\nfile.txt"');
    expect(quoteGitPatchPath('quo"te.txt')).toBe('"quo\\"te.txt"');
    expect(quoteGitPatchPath("back\\slash.txt")).toBe('"back\\\\slash.txt"');
    expect(quoteGitPatchPath(`ring${BELL}.txt`)).toBe('"ring\\a.txt"');
  });

  it("writes the octal of a control character git has no name for", () => {
    expect(quoteGitPatchPath(`unit${UNIT_SEPARATOR}.txt`)).toBe('"unit\\037.txt"');
    expect(quoteGitPatchPath(`del${DELETE}.txt`)).toBe('"del\\177.txt"');
  });
});

describe("a name written into a header and read back out", () => {
  const names = [
    "src/app.ts",
    "with space.txt",
    "café/résumé.ts",
    "🚀.ts",
    "tab\tfile.txt",
    "line\nfile.txt",
    "carriage\rfile.txt",
    'quo"te.txt',
    "back\\slash.txt",
    `ring${BELL}.txt`,
    `unit${UNIT_SEPARATOR}.txt`,
    `del${DELETE}.txt`,
    `every\t\n\r"\\${BELL}.txt`,
  ];

  for (const name of names) {
    it(`is the name that went in: ${JSON.stringify(name)}`, () => {
      const written = quoteGitPatchPath(name);
      expect(unquoteGitPatchPath(written)).toBe(name);
      // A parser that takes the quotes off itself, as the clients' one does, gets there too.
      const unwrapped = written.startsWith('"') ? written.slice(1, -1) : written;
      expect(unquoteGitPatchPath(unwrapped)).toBe(name);
    });
  }

  it("carries the whole name past the first thing a header stops at", () => {
    const written = quoteGitPatchPath("tab\tfile.txt");

    // The bug this guards: a header line ends at a tab and splits on a space, so the name written
    // as itself would be read as `tab` and marked viewed under a path no host has.
    expect(written).not.toContain("\t");
    expect(written).not.toContain("\n");
    expect(unquoteGitPatchPath(written)).not.toBe("tab");
  });
});

describe("unquoteGitPatchPath", () => {
  it("leaves a token git saw no need to quote alone", () => {
    expect(unquoteGitPatchPath("src/app.ts")).toBe("src/app.ts");
    expect(unquoteGitPatchPath("with space.txt")).toBe("with space.txt");
    expect(unquoteGitPatchPath("")).toBe("");
    expect(unquoteGitPatchPath('"')).toBe('"');
  });

  it("reads the octal escapes a host with core.quotePath on writes", () => {
    expect(unquoteGitPatchPath('"caf\\303\\251/r\\303\\251sum\\303\\251.ts"')).toBe(
      "café/résumé.ts",
    );
    expect(unquoteGitPatchPath('"\\360\\237\\232\\200.ts"')).toBe("🚀.ts");
  });
});

describe("a name a parser handed back with its quotes already off", () => {
  it("is read for the escapes it still carries", () => {
    expect(unquoteGitPatchPath("tab\\tfile.txt")).toBe("tab\tfile.txt");
    expect(unquoteGitPatchPath("caf\\303\\251.ts")).toBe("café.ts");
  });

  it("reads an escape git would never write the way C reads it", () => {
    expect(unquoteGitPatchPath("odd\\zname.txt")).toBe("oddzname.txt");
    expect(unquoteGitPatchPath("trailing\\")).toBe("trailing\\");
    expect(unquoteGitPatchPath("short\\12.txt")).toBe("short12.txt");
  });
});
