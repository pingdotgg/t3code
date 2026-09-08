import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cases, IS_WINDOWS } from "./fixtures/cases.ts";

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

const withoutEndingSlash = (value: string) => value.replace(/\/$/, "");

const containsAnotherPath = (
  candidate: string,
  index: number,
  paths: string[],
) => {
  const path = withoutEndingSlash(candidate);
  return paths.some(
    (other, otherIndex) =>
      otherIndex !== index &&
      (other === path ||
        (other.startsWith(path) && other[path.length] === "/")),
  );
};

const nativeGitResult = (
  patterns: Array<string | { pattern: string }> | string,
  paths: string[],
) => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-node-ignore-"));
  try {
    const contents =
      typeof patterns === "string"
        ? patterns
        : patterns
            .map((rule) => (typeof rule === "string" ? rule : rule.pattern))
            .join("\n");
    writeFileSync(join(root, ".gitignore"), contents);

    paths.forEach((path, index) => {
      if (path === ".gitignore" || containsAnotherPath(path, index, paths))
        return;
      const target = join(root, path);
      if (path.endsWith("/")) {
        mkdirSync(target, { recursive: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "");
      }
    });

    execFileSync("git", ["init", "--quiet"], { cwd: root });
    return paths.filter((path) => {
      const result = spawnSync("git", ["check-ignore", "--no-index", path], {
        cwd: root,
        encoding: "utf8",
      });
      return result.status !== 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe.skipIf(IS_WINDOWS || !gitAvailable)(
  "parity with git check-ignore",
  () => {
    cases(({ description, patterns, skip_test_fixture, paths, expected }) => {
      if (
        skip_test_fixture ||
        !paths.some(Boolean) ||
        !expected.every((path: string) => !path.startsWith(".git/"))
      ) {
        return;
      }

      it(description, () => {
        expect(nativeGitResult(patterns, paths).sort()).toEqual(
          expected.sort(),
        );
      });
    });
  },
);
