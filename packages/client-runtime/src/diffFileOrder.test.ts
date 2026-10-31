import { describe, expect, it } from "vite-plus/test";

import { orderDiffFilesForReview } from "./diffFileOrder.ts";

interface TestFile {
  readonly name: string;
  readonly additionLines: ReadonlyArray<string>;
  readonly deletionLines: ReadonlyArray<string>;
}

function file(name: string, additionLines: ReadonlyArray<string> = []): TestFile {
  return { name, additionLines, deletionLines: [] };
}

function order(files: ReadonlyArray<TestFile>): Array<string> {
  return orderDiffFilesForReview(files, (entry) => entry.name).map((entry) => entry.name);
}

describe("orderDiffFilesForReview", () => {
  it("places source before tests and generated files across path conventions", () => {
    const source = ["src/app.ts", "src/dist.ts", "src/testing.ts"];
    const tests = [
      "src/__tests__/app.ts",
      "src/app.spec.tsx",
      "src/app.test.ts",
      "test/app.ts",
      "tests/helpers/app.ts",
    ];
    const generated = [
      "apps/web/package-lock.json",
      "dist/app.js",
      "packages/core/vendor/lib.js",
      "pnpm-lock.yaml",
      "public/app.min.js",
      "src/__snapshots__/app.ts",
      "src/api.generated.ts",
      "src/app.test.ts.snap",
    ];
    expect(
      order([...generated, ...tests, ...source].toReversed().map((path) => file(path))),
    ).toEqual([
      ...source,
      ...tests.slice(0, 3),
      // Generated files under src/ stay in src/ so the list matches the tree.
      "src/__snapshots__/app.ts",
      "src/api.generated.ts",
      "src/app.test.ts.snap",
      ...tests.slice(3),
      ...generated.slice(0, 5),
    ]);
  });

  it("keeps both entries of a path that changed type, such as a file replaced by a symlink", () => {
    const deleted = { ...file("AGENTS.md"), additionLines: [], deletionLines: ["# Agents"] };
    const added = file("AGENTS.md", ["CLAUDE.md"]);
    expect(
      orderDiffFilesForReview([file("CLAUDE.md"), deleted, added], (entry) => entry.name),
    ).toEqual([deleted, added, file("CLAUDE.md")]);
  });

  it("pulls a test listed last into its directory, keeping the first-seen order", () => {
    expect(
      order([
        file("server/device/Host.ts"),
        file("web/settings.ts"),
        file("server/ws.ts"),
        file("server/device/Host.test.ts"),
        file("web/settings.test.ts"),
      ]),
    ).toEqual([
      "server/device/Host.ts",
      "server/device/Host.test.ts",
      "server/ws.ts",
      "web/settings.ts",
      "web/settings.test.ts",
    ]);
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
});
