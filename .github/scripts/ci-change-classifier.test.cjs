const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { classifyChangedPaths, run } = require("./ci-change-classifier.cjs");

const none = {
  check: false,
  fullCheck: false,
  test: false,
  testServer: false,
  rust: false,
  mobileNative: false,
  releaseSmoke: false,
};

const all = {
  check: true,
  fullCheck: true,
  test: true,
  testServer: true,
  rust: true,
  mobileNative: true,
  releaseSmoke: true,
};

test("skips every runner for documentation and repository metadata", () => {
  assert.deepEqual(
    classifyChangedPaths([
      "docs/internals/ci.md",
      "AGENTS.md",
      ".github/VOUCHED.td",
      ".agents/skills/example/SKILL.md",
      ".vscode/settings.json",
    ]),
    none,
  );
});

test("keeps the repository-owned PR asset rejection active", () => {
  assert.deepEqual(classifyChangedPaths([".github/pr-assets/example.svg"]), {
    ...none,
    check: true,
    fullCheck: true,
  });
});

test("runs only the non-server node gates for web code", () => {
  assert.deepEqual(classifyChangedPaths(["apps/web/src/main.tsx"]), {
    ...none,
    check: true,
    fullCheck: true,
    test: true,
  });
});

test("runs only the server node gates for server code", () => {
  assert.deepEqual(classifyChangedPaths(["apps/server/src/server.ts"]), {
    ...none,
    check: true,
    fullCheck: true,
    testServer: true,
  });
});

test("runs both node test groups for shared server dependencies", () => {
  for (const file of [
    "packages/contracts/src/index.ts",
    "packages/shared/src/model.ts",
    "packages/tailscale/src/index.ts",
    "packages/effect-acp/src/index.ts",
    "packages/effect-codex-app-server/src/index.ts",
    "scripts/lib/public-config.ts",
  ]) {
    const result = classifyChangedPaths([file]);
    assert.equal(result.check, true, file);
    assert.equal(result.test, true, file);
    assert.equal(result.testServer, true, file);
  }
});

test("runs server shards for cross-surface modules imported by server tests", () => {
  for (const file of [
    "apps/web/src/lib/contextWindow.ts",
    "apps/web/src/session-logic.ts",
    "apps/mobile/src/lib/threadActivity.ts",
  ]) {
    assert.equal(classifyChangedPaths([file]).testServer, true, file);
  }
});

test("keeps unrelated client-only packages off the server shards", () => {
  for (const file of [
    "apps/desktop/src/main.ts",
    "apps/mobile/src/app.tsx",
    "packages/client-runtime/src/index.ts",
    "packages/ssh/src/index.ts",
    "infra/relay/src/worker.ts",
    "oxlint-plugin-t3code/index.ts",
  ]) {
    const result = classifyChangedPaths([file]);
    assert.equal(result.check, true, file);
    assert.equal(result.test, true, file);
    assert.equal(result.testServer, false, file);
  }
});

test("runs only Rust for resource monitor changes", () => {
  assert.deepEqual(classifyChangedPaths(["native/resource-monitor/src/main.rs"]), {
    ...none,
    rust: true,
  });
  assert.equal(classifyChangedPaths(["native/resource-monitor/Cargo.lock"]).rust, true);
  assert.equal(classifyChangedPaths(["native/resource-monitor/Cargo.toml"]).rust, true);
});

test("runs only mobile native analysis for native module sources", () => {
  assert.deepEqual(
    classifyChangedPaths(["apps/mobile/modules/t3-terminal/ios/TerminalView.swift"]),
    {
      ...none,
      mobileNative: true,
    },
  );
  assert.equal(classifyChangedPaths(["apps/mobile/ios/AppDelegate.swift"]).mobileNative, false);
  assert.equal(
    classifyChangedPaths(["apps/mobile/android/app/MainActivity.kt"]).mobileNative,
    false,
  );
});

test("includes every direct mobile native analysis input", () => {
  for (const file of [
    "apps/mobile/Brewfile",
    "apps/mobile/.swiftlint.yml",
    "apps/mobile/detekt.yml",
    "apps/mobile/modules/example/.editorconfig",
    "scripts/mobile-native-static-check.ts",
    "packages/shared/src/shell.ts",
    "packages/shared/src/hostProcess.ts",
  ]) {
    assert.equal(classifyChangedPaths([file]).mobileNative, true, file);
  }
});

test("runs release smoke only for files the smoke test reads", () => {
  assert.equal(classifyChangedPaths(["apps/web/src/main.tsx"]).releaseSmoke, false);
  assert.equal(classifyChangedPaths(["docs/package.json"]).releaseSmoke, false);
  for (const file of [
    "pnpm-lock.yaml",
    "apps/web/package.json",
    "patches/example.patch",
    "apps/mobile/deps/example.tgz",
    "scripts/release-smoke.ts",
    "scripts/update-release-package-versions.ts",
    "scripts/resolve-nightly-release.ts",
    "scripts/merge-update-manifests.ts",
    "scripts/lib/update-manifest.ts",
    "packages/shared/src/schemaJson.ts",
    ".github/workflows/release.yml",
  ]) {
    assert.equal(classifyChangedPaths([file]).releaseSmoke, true, file);
  }
});

test("runs every relevant node gate for workspace-wide inputs", () => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vite.config.ts",
    "tsconfig.base.json",
    "patches/effect.patch",
  ]) {
    const result = classifyChangedPaths([file]);
    assert.equal(result.check, true, file);
    assert.equal(result.test, true, file);
    assert.equal(result.testServer, true, file);
  }
});

test("keeps workflow-only changes out of product checks", () => {
  assert.deepEqual(classifyChangedPaths([".github/workflows/pr-vouch.yml"]), {
    ...none,
    check: true,
  });
  assert.deepEqual(classifyChangedPaths([".github/workflows/release.yml"]), {
    ...none,
    check: true,
    releaseSmoke: true,
  });
});

test("runs every gate when CI controls change", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/scripts/ci-change-classifier.cjs",
    ".github/scripts/ci-change-classifier.test.cjs",
  ]) {
    assert.deepEqual(classifyChangedPaths([file]), all, file);
  }
});

test("fails open for an empty or unknown changed path list", () => {
  assert.deepEqual(classifyChangedPaths([]), all);
  assert.deepEqual(classifyChangedPaths(["new-top-level-product-input.bin"]), {
    ...none,
    check: true,
    fullCheck: true,
    test: true,
    testServer: true,
  });
});

test("classifies both sides of a rename and writes string outputs", async () => {
  const outputs = {};
  const listFiles = () => {};
  await run({
    github: {
      paginate: async (method, input) => {
        assert.equal(method, listFiles);
        assert.equal(input.pull_number, 42);
        return [
          {
            filename: "docs/old-server.md",
            previous_filename: "apps/server/src/old-server.ts",
          },
        ];
      },
      rest: { pulls: { listFiles } },
    },
    context: {
      eventName: "pull_request",
      payload: { pull_request: { number: 42, changed_files: 1 } },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.deepEqual(outputs, {
    check: "true",
    full_check: "true",
    test: "false",
    test_server: "true",
    rust: "false",
    mobile_native: "false",
    release_smoke: "false",
  });
});

test("classifies files in a push to main", async () => {
  const outputs = {};
  const compareCommitsWithBasehead = async (input) => {
    assert.equal(input.basehead, "before...after");
    return { data: { files: [{ filename: "native/resource-monitor/src/main.rs" }] } };
  };
  await run({
    github: { rest: { repos: { compareCommitsWithBasehead } } },
    context: {
      eventName: "push",
      payload: { before: "before", after: "after" },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.equal(outputs.rust, "true");
  assert.equal(outputs.check, "false");
  assert.equal(outputs.test_server, "false");
});

test("fails open when GitHub truncates a pull request file list", async () => {
  const outputs = {};
  const listFiles = () => {};
  await run({
    github: {
      paginate: async () => [{ filename: "docs/example.md" }],
      rest: { pulls: { listFiles } },
    },
    context: {
      eventName: "pull_request",
      payload: { pull_request: { number: 42, changed_files: 2 } },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.deepEqual(outputs, {
    check: "true",
    full_check: "true",
    test: "true",
    test_server: "true",
    rust: "true",
    mobile_native: "true",
    release_smoke: "true",
  });
});

test("fails open when a push comparison reaches GitHub's file limit", async () => {
  const outputs = {};
  await run({
    github: {
      rest: {
        repos: {
          compareCommitsWithBasehead: async () => ({
            data: {
              files: Array.from({ length: 300 }, (_, index) => ({
                filename: `docs/example-${index}.md`,
              })),
            },
          }),
        },
      },
    },
    context: {
      eventName: "push",
      payload: { before: "before", after: "after" },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.equal(outputs.test, "true");
  assert.equal(outputs.test_server, "true");
  assert.equal(outputs.rust, "true");
});

test("server shard checks keep fixed names when skipped", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  for (const shard of [1, 2, 3]) {
    assert.match(workflow, new RegExp(`name: Test Server ${shard}\\n`));
  }
  assert.doesNotMatch(workflow, /name: Test Server \$\{\{ matrix\.shard \}\}/);
  assert.match(workflow, /steps: &server-test-steps/);
  assert.equal(workflow.match(/steps: \*server-test-steps/g)?.length, 2);
});

test("workflow gates fail open on missing classifier outputs", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  for (const output of ["check", "test", "test_server", "rust", "mobile_native", "release_smoke"]) {
    assert.match(workflow, new RegExp(`outputs\\.${output} != 'false'`));
  }
  assert.match(workflow, /outputs\.full_check != 'false'/);
  assert.doesNotMatch(workflow, /needs\.classify\.outputs\.[a-z_]+ == 'true'/);
  assert.equal(workflow.match(/!cancelled\(\) &&/g)?.length, 8);
});
