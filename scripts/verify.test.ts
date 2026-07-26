import { assert, describe, it } from "@effect/vitest";

import type { ChangedScope } from "./lib/changed-scope.ts";
import { planSteps } from "./verify.ts";

const emptyScope: ChangedScope = {
  packages: [],
  touchesMac: false,
  touchesMobileNative: false,
  touchesWorkspaceRoot: false,
  relatedSources: [],
  checkPaths: [],
};

const scopeOf = (overrides: Partial<ChangedScope>): ChangedScope => ({
  ...emptyScope,
  ...overrides,
});

const labels = (scope: ChangedScope, all = false) =>
  planSteps(scope, { all }).map((step) => step.label);

const commandFor = (scope: ChangedScope, label: string) => {
  const step = planSteps(scope, { all: false }).find((candidate) =>
    candidate.label.startsWith(label),
  );
  assert.isDefined(step, `expected a step labelled '${label}'`);
  return [step.command, ...step.args].join(" ");
};

describe("planSteps", () => {
  it("plans nothing when nothing checkable changed", () => {
    assert.deepStrictEqual(planSteps(emptyScope, { all: false }), []);
  });

  it("scopes check to the changed files", () => {
    const scope = scopeOf({
      checkPaths: ["packages/shared/src/a.ts"],
      relatedSources: ["packages/shared/src/a.ts"],
      packages: ["@t3tools/shared"],
    });
    assert.strictEqual(commandFor(scope, "check"), "vp check packages/shared/src/a.ts");
  });

  it("typechecks the changed packages and their dependents", () => {
    const scope = scopeOf({
      packages: ["@t3tools/contracts"],
      relatedSources: ["packages/contracts/src/model.ts"],
      checkPaths: ["packages/contracts/src/model.ts"],
    });
    assert.strictEqual(
      commandFor(scope, "typecheck"),
      "vp run --filter ...@t3tools/contracts --concurrency-limit 2 typecheck",
    );
  });

  it("runs only the tests related to the changed sources", () => {
    const scope = scopeOf({
      relatedSources: ["packages/shared/src/a.ts", "packages/shared/src/b.ts"],
      packages: ["@t3tools/shared"],
      checkPaths: ["packages/shared/src/a.ts", "packages/shared/src/b.ts"],
    });
    assert.strictEqual(
      commandFor(scope, "test (related)"),
      "vp test related --run packages/shared/src/a.ts packages/shared/src/b.ts",
    );
  });

  it("adds the Swift suite only when apps/mac changed", () => {
    assert.notInclude(labels(scopeOf({ packages: ["t3"] })), "swift test (apps/mac)");
    assert.include(labels(scopeOf({ touchesMac: true })), "swift test (apps/mac)");
  });

  it("adds lint:mobile only when native mobile sources changed", () => {
    assert.notInclude(labels(scopeOf({ packages: ["@t3tools/mobile"] })), "lint:mobile");
    assert.include(labels(scopeOf({ touchesMobileNative: true })), "lint:mobile");
  });

  it("falls back to the whole suite when a workspace-root input changed", () => {
    assert.deepStrictEqual(labels(scopeOf({ touchesWorkspaceRoot: true })), [
      "check (all)",
      "typecheck (all)",
      "test (all)",
      "swift test (apps/mac)",
      "lint:mobile",
    ]);
  });

  it("--all runs the full gate regardless of the resolved scope", () => {
    assert.deepStrictEqual(labels(emptyScope, true), [
      "check (all)",
      "typecheck (all)",
      "test (all)",
      "swift test (apps/mac)",
      "lint:mobile",
    ]);
  });

  it("never mixes scoped and full steps for the same concern", () => {
    const scoped = labels(scopeOf({ packages: ["t3"], relatedSources: ["apps/server/src/ws.ts"] }));
    assert.notInclude(scoped, "test (all)");
    assert.notInclude(scoped, "typecheck (all)");
  });
});
