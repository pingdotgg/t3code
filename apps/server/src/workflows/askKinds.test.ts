import { assert, it } from "@effect/vitest";

import { undeclaredAskKinds } from "./askKinds.ts";

const declared = new Set(["feature", "intended"]);

it("finds an ask whose literal kind is not declared, with its line", () => {
  const source = [
    "yield* step('a', {}, Effect.void);",
    'yield* ask("decide", { title: "Wanted?", kind: "feture", choices: ["Yes", "No"] });',
  ].join("\n");
  assert.deepStrictEqual(undeclaredAskKinds(source, declared), [{ kind: "feture", line: 2 }]);
});

it("leaves declared kinds, computed kinds, nested kinds and other calls alone", () => {
  const source = `
    yield* ask("a", { kind: "feature", title: "x", choices: ["Yes"] });
    yield* ask("b", { kind: payload.kind, title: "x", choices: ["Yes"] });
    yield* ask("c", { title: "(x}", choices: ["Yes"], data: { kind: "issue" } });
    yield* task("d", { kind: "other" });
    // yield* ask("e", { kind: "commented" })
    yield* T3.ask("f", { title: "x", choices: ["Yes"], kind: 'intended' });
  `;
  assert.deepStrictEqual(undeclaredAskKinds(source, declared), []);
});

it("reads an unclosed call no further than its limit", () => {
  const source = `ask(${"(".repeat(10_000)} { kind: "far" }`;
  assert.deepStrictEqual(undeclaredAskKinds(source, declared), []);
});
