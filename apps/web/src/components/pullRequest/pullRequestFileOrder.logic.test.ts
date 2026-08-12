import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { diffFileTier, orderDiffFiles } from "./pullRequestFileOrder.logic";

/** Only the path and the patch's own lines matter here; the viewer fills the rest in. */
function file(name: string, additionLines: ReadonlyArray<string> = []): FileDiffMetadata {
  return { name, hunks: [], additionLines, deletionLines: [] } as unknown as FileDiffMetadata;
}

function order(files: ReadonlyArray<FileDiffMetadata>): Array<string> {
  return orderDiffFiles(files).map((entry) => entry.name);
}

describe("diffFileTier", () => {
  it("puts lockfiles, snapshots and build output last", () => {
    expect(diffFileTier("pnpm-lock.yaml")).toBe("generated");
    expect(diffFileTier("apps/web/package-lock.json")).toBe("generated");
    expect(diffFileTier("src/__snapshots__/app.ts")).toBe("generated");
    expect(diffFileTier("src/app.test.ts.snap")).toBe("generated");
    expect(diffFileTier("src/api.generated.ts")).toBe("generated");
    expect(diffFileTier("public/app.min.js")).toBe("generated");
    expect(diffFileTier("dist/app.js")).toBe("generated");
    expect(diffFileTier("packages/core/vendor/lib.js")).toBe("generated");
  });

  it("recognises a test by its name or by the directory holding it", () => {
    expect(diffFileTier("src/app.test.ts")).toBe("test");
    expect(diffFileTier("src/app.spec.tsx")).toBe("test");
    expect(diffFileTier("src/__tests__/app.ts")).toBe("test");
    expect(diffFileTier("test/app.ts")).toBe("test");
    expect(diffFileTier("tests/helpers/app.ts")).toBe("test");
  });

  it("treats everything else as source, including files merely named like a directory", () => {
    expect(diffFileTier("src/app.ts")).toBe("source");
    expect(diffFileTier("src/testing.ts")).toBe("source");
    expect(diffFileTier("src/dist.ts")).toBe("source");
  });
});

describe("orderDiffFiles", () => {
  it("answers an empty diff with an empty order", () => {
    expect(order([])).toEqual([]);
  });

  it("puts a dependency before what imports it", () => {
    expect(order([file("src/a.ts", ['import { b } from "./b";']), file("src/b.ts")])).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("follows a chain the whole way down", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts", ['import { c } from "./c";']),
        file("src/c.ts"),
      ]),
    ).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);
  });

  it("resolves a specifier that climbs out of the importer's directory", () => {
    expect(
      order([file("src/ui/a.ts", ['import { b } from "../lib/b";']), file("src/lib/b.ts")]),
    ).toEqual(["src/lib/b.ts", "src/ui/a.ts"]);
  });

  it("resolves a directory specifier to that directory's index file", () => {
    expect(
      order([file("src/a.ts", ['import { b } from "./lib";']), file("src/lib/index.ts")]),
    ).toEqual(["src/lib/index.ts", "src/a.ts"]);
  });

  it("falls back to the specifier's last segment when the path does not line up", () => {
    // An aliased import (`~/lib/b`) resolves to nothing on disk here, but the diff has only one
    // file that could be meant.
    expect(order([file("src/a.ts", ['import { b } from "~/lib/b";']), file("lib/b.ts")])).toEqual([
      "lib/b.ts",
      "src/a.ts",
    ]);
  });

  it("ignores an ambiguous last segment rather than guessing", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "~/somewhere/b";']),
        file("one/b.ts"),
        file("two/b.ts"),
      ]),
    ).toEqual(["one/b.ts", "src/a.ts", "two/b.ts"]);
  });

  it("resolves a specifier naming an extension, including the .js beside a .ts", () => {
    expect(order([file("src/a.ts", ['import { b } from "./b.js";']), file("src/b.ts")])).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("reads require and bare imports too", () => {
    expect(
      order([
        file("src/a.ts", ['const b = require("./b");', 'import "./c";']),
        file("src/b.ts"),
        file("src/c.ts"),
      ]),
    ).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
  });

  it("falls back to path order inside a cycle", () => {
    expect(
      order([
        file("src/b.ts", ['import { a } from "./a";']),
        file("src/a.ts", ['import { b } from "./b";']),
      ]),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("clusters unrelated files by path", () => {
    expect(order([file("src/ui/b.ts"), file("src/lib/z.ts"), file("src/lib/a.ts")])).toEqual([
      "src/lib/a.ts",
      "src/lib/z.ts",
      "src/ui/b.ts",
    ]);
  });

  it("keeps the tiers apart and orders tests by the source they cover", () => {
    expect(
      order([
        file("pnpm-lock.yaml"),
        file("src/a.test.ts"),
        file("src/__tests__/b.ts"),
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts"),
        file("dist/a.js"),
      ]),
    ).toEqual([
      "src/b.ts",
      "src/a.ts",
      "src/__tests__/b.ts",
      "src/a.test.ts",
      "dist/a.js",
      "pnpm-lock.yaml",
    ]);
  });

  it("puts a test with no source in the diff after the ones that have theirs", () => {
    expect(order([file("src/orphan.spec.ts"), file("src/a.test.ts"), file("src/a.ts")])).toEqual([
      "src/a.ts",
      "src/a.test.ts",
      "src/orphan.spec.ts",
    ]);
  });

  it("orders the same diff the same way whatever order it arrives in", () => {
    const files = [
      file("src/a.ts", ['import { b } from "./b";']),
      file("src/b.ts"),
      file("src/c.ts"),
      file("src/a.test.ts"),
      file("yarn.lock"),
    ];
    expect(order(files)).toEqual(order(files.toReversed()));
  });
});
