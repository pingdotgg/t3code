import { describe, expect, it } from "bun:test";
import ignore from "../src/ignore.ts";
import { cases, SHOULD_TEST_WINDOWS } from "./fixtures/cases.ts";

type UpstreamCase = {
  description: string;
  patterns: Parameters<ReturnType<typeof ignore>["add"]>[0];
  paths_object: Record<string, unknown>;
  paths: string[];
  expected: string[];
  scopes: false | string[];
};

describe("ignore v7.0.5 upstream cases", () => {
  cases((testCase: UpstreamCase) => {
    const { description, patterns, paths_object, paths, expected, scopes } =
      testCase;

    if (scopes === false || scopes.includes("filter")) {
      it(`filter: ${description}`, () => {
        expect(ignore().add(patterns).filter(paths).sort()).toEqual(
          [...expected].sort(),
        );
      });

      it(`createFilter: ${description}`, () => {
        expect(
          paths.filter(ignore().add(patterns).createFilter()).sort(),
        ).toEqual([...expected].sort());
      });
    }

    if (scopes === false || scopes.includes("ignores")) {
      it(`ignores: ${description}`, () => {
        const matcher = ignore().add(patterns);
        for (const [path, ignored] of Object.entries(paths_object)) {
          expect(matcher.ignores(path)).toBe(Boolean(ignored));
        }
      });
    }

    if (scopes === false || scopes.includes("checkIgnore")) {
      it(`checkIgnore: ${description}`, () => {
        const matcher = ignore().add(patterns);
        for (const [path, ignored] of Object.entries(paths_object)) {
          expect(matcher.checkIgnore(path).ignored).toBe(Boolean(ignored));
        }
      });
    }

    if (
      SHOULD_TEST_WINDOWS &&
      (scopes === false || scopes.includes("filter"))
    ) {
      it(`win32 filter: ${description}`, () => {
        const windowsPaths = paths.map((path) => path.replaceAll("/", "\\"));
        expect(ignore().add(patterns).filter(windowsPaths).sort()).toEqual(
          expected.map((path) => path.replaceAll("/", "\\")).sort(),
        );
      });
    }
  });
});
