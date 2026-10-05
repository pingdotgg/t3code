import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, it } from "../src/Api.ts";
import { forEachTest, type TestCase } from "../src/Model.ts";
import { collect } from "../src/Registry.ts";
import { compileTagsFilter, mergeTags } from "../src/Tags.ts";

test("opt-in tags require exact positive selection of every required tag", () => {
  const matches = (expressions: string[], optInTags = ["slow"]) =>
    compileTagsFilter(expressions)(["provider:aws"], optInTags);
  for (const expressions of [
    [],
    ["provider:aws"],
    ["!unit"],
    ["*"],
    ["sl*"],
    ["SLOW"],
    ["!!slow"],
    ["not (not slow)"],
    ["!(slow && unit)"],
  ]) {
    expect(matches(expressions)).toBe(false);
  }
  expect(matches(["provider:aws && slow"])).toBe(true);
  expect(matches(["slow || unit"])).toBe(true);
  expect(matches(["slow", "provider:aws"])).toBe(true);
  expect(matches(["slow && provider:cloudflare"])).toBe(false);
  expect(matches(["slow"], ["slow", "requires:enterprise"])).toBe(false);
  expect(matches(["slow && requires:*"], ["slow", "requires:enterprise"])).toBe(
    false,
  );
  expect(
    matches(["slow", "requires:enterprise"], ["slow", "requires:enterprise"]),
  ).toBe(true);
  expect(compileTagsFilter([])(["unit"])).toBe(true);
  expect(matches([], [])).toBe(true);
  expect(matches(["provider:*"], [])).toBe(true);
});

test("Alchemy tests and provider tests forward tags", async () => {
  const { make } = await import("../../alchemy/src/Test/Alchemy.ts");
  const suite = await collect("adapter.test.ts", async () => {
    const api = make({ providers: Layer.empty, dev: false, sidecar: false });
    describe(
      "provider",
      { tags: ["e2e", "provider:cloudflare"], optInTags: ["enterprise"] },
      () => {
        api.test("effect", Effect.void, { tags: "dev", optInTags: ["slow"] });
        api.test.provider("provider", () => Effect.void, {
          tags: "live",
          optInTags: ["slow"],
        });
        api.test.provider.skip("skipped", () => Effect.void, {
          tags: "live",
          optInTags: ["slow"],
        });
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const tests: TestCase[] = [];
    forEachTest(suite, (test) => tests.push(test));
    expect(tests.map((test) => test.optInTags)).toEqual(
      Array(3).fill(["enterprise", "slow"]),
    );
    expect(tests.map((test) => test.tags)).toEqual([
      ["e2e", "provider:cloudflare", "dev"],
      ["e2e", "provider:cloudflare", "live"],
      ["e2e", "provider:cloudflare", "live"],
    ]);
  } finally {
    for (const hook of suite.afterAll) await Effect.runPromise(hook.body());
  }
});

test("tag expressions support precedence, grouping, negation and wildcards", () => {
  const matches = (expression: string, tags: string[]) =>
    compileTagsFilter([expression])(tags);
  expect(matches("unit || e2e && live", ["unit"])).toBe(true);
  expect(matches("unit || e2e && live", ["e2e"])).toBe(false);
  expect(matches("(unit || e2e) && live", ["unit"])).toBe(false);
  expect(matches("(unit || e2e) && live", ["e2e", "live"])).toBe(true);
  expect(
    matches("e2e AND provider:aws and NOT slow", ["e2e", "provider:aws"]),
  ).toBe(true);
  expect(matches("e2e && !slow", ["e2e", "slow"])).toBe(false);
  expect(matches("!!unit", ["unit"])).toBe(true);
  expect(matches("provider:*", ["provider:cloudflare"])).toBe(true);
  expect(matches("provider:*", ["other:provider:aws"])).toBe(false);
  expect(matches("provider:aws", ["provider:aws-extra"])).toBe(false);
  expect(matches("a.b", ["axb"])).toBe(false);
  expect(matches("a.b", ["a.b"])).toBe(true);
  expect(matches("!live", [])).toBe(true);
  expect(matches("*", [])).toBe(false);
  expect(compileTagsFilter([])([])).toBe(true);
  expect(compileTagsFilter(["unit || e2e", "!slow"])(["unit", "slow"])).toBe(
    false,
  );
});

test("malformed expressions fail eagerly, including short-circuited operands", () => {
  for (const expression of [
    "",
    " ",
    "unit &&",
    "unit ||",
    "unit slow",
    "(unit",
    "unit)",
    "()",
    "!",
    "unit & core",
    "unit | core",
    "unit || && core",
    "and",
    "unit && ()",
  ]) {
    expect(() => compileTagsFilter([expression])).toThrow("Invalid --tags");
  }
});

test("tag names reject expression syntax and merge without duplicates", () => {
  expect(mergeTags(["unit"], ["unit", "core"])).toEqual(["unit", "core"]);
  for (const tag of [
    "",
    "two words",
    "and",
    "OR",
    "not",
    "provider:*",
    "!slow",
    "a(b)",
    "a|b",
  ]) {
    expect(() => mergeTags([], [tag])).toThrow("Invalid test tag");
  }
});

test("all registration variants inherit suite tags and add their own", async () => {
  const suite = await collect("tags.test.ts", async () => {
    describe(
      "outer",
      { tags: ["e2e", "provider:aws"], optInTags: ["enterprise"] },
      () => {
        describe(
          "inner",
          { tags: ["live", "e2e"], optInTags: ["enterprise"] },
          () => {
            it("plain", () => {}, { tags: "slow", optInTags: ["slow"] });
            it.skip("skipped", () => {}, { tags: "slow", optInTags: ["slow"] });
            it.only("only", () => {}, { tags: "slow", optInTags: ["slow"] });
            it.todo("todo", undefined, { tags: "slow", optInTags: ["slow"] });
            it.fails("fails", () => {}, { tags: "slow", optInTags: ["slow"] });
            it.skipIf(true)("conditional", () => {}, {
              tags: "slow",
              optInTags: ["slow"],
            });
            it.runIf(true)("conditional-run", () => {}, {
              tags: "slow",
              optInTags: ["slow"],
            });
            it.each([1, 2])("each", () => {}, {
              tags: "slow",
              optInTags: ["slow"],
            });
            it.effect("effect", () => Effect.void, {
              tags: "slow",
              optInTags: ["slow"],
            });
            it.live.each([1])("live", () => Effect.void, {
              tags: "slow",
              optInTags: ["slow"],
            });
            describe.each([1])(
              "suite-each",
              () => {
                it("inherited", () => {});
              },
              { tags: "slow", optInTags: ["slow"] },
            );
          },
        );
      },
    );
    it("untagged", () => {});
  });
  const tests: TestCase[] = [];
  forEachTest(suite, (test) => tests.push(test));
  expect(tests).toHaveLength(13);
  for (const test of tests.slice(0, -1)) {
    expect(test.optInTags).toEqual(["enterprise", "slow"]);
    expect(test.tags).toEqual(["e2e", "provider:aws", "live", "slow"]);
  }
  expect(tests.at(-1)!.optInTags).toEqual([]);
  expect(tests.at(-1)!.tags).toEqual([]);
});
