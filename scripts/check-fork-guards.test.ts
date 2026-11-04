import { assert, it } from "@effect/vitest";

import { extractTest, findGuardProblems, hashTest, type ForkGuard } from "./check-fork-guards.ts";

const source = `describe("supervisor", () => {
  it.effect("keeps a slow socket", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("8 seconds");
    }),
  );

  it.effect.each(["a", "b"] as const)(
    "replaces a silent socket (%s)",
    (reason) => Effect.void,
  );
});
`;

const guard = (title: string, body: string): ForkGuard => ({
  fix: "#106",
  protects: "slow sockets survive",
  test: "supervisor.test.ts",
  title,
  sha256: hashTest(body),
  sources: [],
});

it("extracts a test through its closing paren, including each() forms", () => {
  assert.strictEqual(
    extractTest(source, "keeps a slow socket"),
    `  it.effect("keeps a slow socket", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("8 seconds");
    }),
  );
`,
  );
  assert.match(extractTest(source, "replaces a silent socket (%s)") ?? "", /^ {2}it\.effect\.each/);
});

it("accepts an unchanged guard and ignores reformatting", () => {
  const body = extractTest(source, "keeps a slow socket")!;
  const reformatted = source.replace(
    "Effect.gen(function* () {",
    "Effect.gen(\n      function* () {",
  );
  assert.deepStrictEqual(
    findGuardProblems([guard("keeps a slow socket", body)], () => reformatted),
    [],
  );
});

it("names the fix when its guard test is removed or loosened", () => {
  const body = extractTest(source, "keeps a slow socket")!;
  const guards = [guard("keeps a slow socket", body)];
  const [removed] = findGuardProblems(guards, () => source.replace("keeps a slow", "keeps a"));
  assert.match(removed!, /is gone\. It guards fork fix #106 \(slow sockets survive\)/);
  const [loosened] = findGuardProblems(guards, () => source.replace("8 seconds", "15 seconds"));
  assert.match(loosened!, /changed\. It guards fork fix #106/);
  const [deleted] = findGuardProblems(guards, () => undefined);
  assert.match(deleted!, /is gone/);
});
