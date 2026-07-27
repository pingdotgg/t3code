import { assert, describe, it } from "@effect/vitest";

import { dependentFilters, resolveChangedScope, type WorkspacePackage } from "./changed-scope.ts";

const packages: readonly WorkspacePackage[] = [
  { name: "t3", directory: "apps/server" },
  { name: "@t3tools/mobile", directory: "apps/mobile" },
  { name: "@t3tools/contracts", directory: "packages/contracts" },
  { name: "@t3tools/shared", directory: "packages/shared" },
  { name: "@t3tools/scripts", directory: "scripts" },
];

describe("resolveChangedScope", () => {
  it("attributes a file to the package that owns it", () => {
    const scope = resolveChangedScope(["packages/shared/src/autoReview.ts"], packages);
    assert.deepStrictEqual(scope.packages, ["@t3tools/shared"]);
    assert.deepStrictEqual(scope.relatedSources, ["packages/shared/src/autoReview.ts"]);
    assert.isFalse(scope.touchesWorkspaceRoot);
    assert.isFalse(scope.touchesMac);
  });

  it("collects every affected package, sorted and deduplicated", () => {
    const scope = resolveChangedScope(
      ["apps/server/src/ws.ts", "apps/server/src/server.ts", "packages/contracts/src/model.ts"],
      packages,
    );
    assert.deepStrictEqual(scope.packages, ["@t3tools/contracts", "t3"]);
  });

  it("falls back to the full suite when a workspace-root input changes", () => {
    for (const file of [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "vite.config.ts",
      "tsconfig.base.json",
      "package.json",
      "patches/effect@4.0.0.patch",
    ]) {
      const scope = resolveChangedScope([file], packages);
      assert.isTrue(scope.touchesWorkspaceRoot, `${file} should force the full suite`);
    }
  });

  it("does not treat a package's own package.json as a workspace-root input", () => {
    const scope = resolveChangedScope(["packages/shared/package.json"], packages);
    assert.isFalse(scope.touchesWorkspaceRoot);
  });

  it("flags apps/mac for any change under it, including its scripts", () => {
    const swift = resolveChangedScope(["apps/mac/Sources/T3Kit/PathDisplay.swift"], packages);
    assert.isTrue(swift.touchesMac);
    assert.deepStrictEqual(swift.packages, []);

    const script = resolveChangedScope(["apps/mac/scripts/swift-test.sh"], packages);
    assert.isTrue(script.touchesMac);
  });

  it("flags mobile native sources only for native extensions", () => {
    const native = resolveChangedScope(["apps/mobile/modules/audio/Recorder.swift"], packages);
    assert.isTrue(native.touchesMobileNative);

    const kotlin = resolveChangedScope(["apps/mobile/modules/audio/Recorder.kt"], packages);
    assert.isTrue(kotlin.touchesMobileNative);

    const typescript = resolveChangedScope(["apps/mobile/src/app/index.tsx"], packages);
    assert.isFalse(typescript.touchesMobileNative);
    assert.deepStrictEqual(typescript.packages, ["@t3tools/mobile"]);
  });

  it("ignores paths that cannot affect any check", () => {
    const scope = resolveChangedScope(
      [
        ".repos/effect-smol/LLMS.md",
        ".plans/some-plan.md",
        "docs/architecture.md",
        "node_modules/whatever/index.js",
        "",
      ],
      packages,
    );
    assert.deepStrictEqual(scope.packages, []);
    assert.deepStrictEqual(scope.checkPaths, []);
    assert.deepStrictEqual(scope.relatedSources, []);
    assert.isFalse(scope.touchesWorkspaceRoot);
  });

  it("sends formattable non-source files to check but not to tests", () => {
    const scope = resolveChangedScope(["AGENTS.md", "apps/server/src/config.json"], packages);
    assert.deepStrictEqual(scope.checkPaths, ["AGENTS.md", "apps/server/src/config.json"]);
    assert.deepStrictEqual(scope.relatedSources, []);
    assert.deepStrictEqual(scope.packages, []);
  });

  it("gives a nested package precedence over its ancestor", () => {
    const nested: readonly WorkspacePackage[] = [
      ...packages,
      { name: "@t3tools/mobile-native", directory: "apps/mobile/modules/native" },
    ];
    const scope = resolveChangedScope(["apps/mobile/modules/native/src/index.ts"], nested);
    assert.deepStrictEqual(scope.packages, ["@t3tools/mobile-native"]);
  });

  it("routes shell scripts and git hooks to the package whose tests spawn them", () => {
    // Neither is in any module graph, so `vitest related` cannot reach
    // scripts/setup-worktree.test.ts or scripts/pre-commit-hook.test.ts on its
    // own — the change that most needs those tests would skip them.
    for (const file of [
      "scripts/setup-worktree.sh",
      ".vite-hooks/pre-commit",
      ".vite-hooks/post-checkout",
      "apps/mac/scripts/swift-test.sh",
    ]) {
      const scope = resolveChangedScope([file], packages);
      assert.include(scope.packages, "@t3tools/scripts", `${file} should re-run the shell tests`);
    }
  });

  it("does not invent a package filter when the shell harness is absent", () => {
    const withoutScripts = packages.filter((candidate) => candidate.name !== "@t3tools/scripts");
    const scope = resolveChangedScope(["scripts/setup-worktree.sh"], withoutScripts);
    assert.deepStrictEqual(scope.packages, []);
  });

  it("keeps deleted files in scope so their package still re-runs", () => {
    const scope = resolveChangedScope(["packages/shared/src/gone.ts"], packages);
    assert.deepStrictEqual(scope.packages, ["@t3tools/shared"]);
  });
});

describe("dependentFilters", () => {
  it("selects each package and its dependents", () => {
    assert.deepStrictEqual(dependentFilters(["@t3tools/contracts", "t3"]), [
      "--filter",
      "...@t3tools/contracts",
      "--filter",
      "...t3",
    ]);
  });

  it("produces no filters for an empty selection", () => {
    assert.deepStrictEqual(dependentFilters([]), []);
  });
});
