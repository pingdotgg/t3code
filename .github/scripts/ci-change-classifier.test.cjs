const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { classifyChangedPaths, run } = require("./ci-change-classifier.cjs");

test("skips heavy jobs for documentation and repository metadata", () => {
  assert.deepEqual(
    classifyChangedPaths([
      "docs/internals/ci.md",
      "AGENTS.md",
      ".github/VOUCHED.td",
      ".github/pr-assets/example.svg",
      "apps/mobile/CHANGELOG.md",
    ]),
    {
      check: false,
      fullCheck: false,
      test: false,
      mobileNative: false,
      releaseSmoke: false,
    },
  );
});

test("runs check and test for product code", () => {
  assert.deepEqual(classifyChangedPaths(["apps/web/src/main.tsx"]), {
    check: true,
    fullCheck: true,
    test: true,
    mobileNative: false,
    releaseSmoke: false,
  });
});

test("fails safe when no changed paths are available", () => {
  assert.deepEqual(classifyChangedPaths([]), {
    check: true,
    fullCheck: true,
    test: true,
    mobileNative: true,
    releaseSmoke: true,
  });
});

test("keeps workflow-only changes out of product checks", () => {
  assert.deepEqual(classifyChangedPaths([".github/workflows/pr-vouch.yml"]), {
    check: true,
    fullCheck: false,
    test: false,
    mobileNative: false,
    releaseSmoke: false,
  });
  assert.deepEqual(classifyChangedPaths([".github/workflows/release.yml"]), {
    check: true,
    fullCheck: false,
    test: false,
    mobileNative: false,
    releaseSmoke: true,
  });
});

test("runs every gate when the CI workflow changes", () => {
  assert.deepEqual(classifyChangedPaths([".github/workflows/ci.yml"]), {
    check: true,
    fullCheck: true,
    test: true,
    mobileNative: true,
    releaseSmoke: true,
  });
  assert.deepEqual(classifyChangedPaths([".github/scripts/ci-change-classifier.cjs"]), {
    check: true,
    fullCheck: true,
    test: true,
    mobileNative: true,
    releaseSmoke: true,
  });
});

test("runs mobile native analysis only for its inputs", () => {
  assert.equal(classifyChangedPaths(["apps/mobile/src/App.tsx"]).mobileNative, false);
  assert.equal(classifyChangedPaths(["packages/shared/README.md"]).mobileNative, false);
  assert.equal(classifyChangedPaths(["apps/mobile/ios/AppDelegate.swift"]).mobileNative, false);
  assert.equal(
    classifyChangedPaths(["apps/mobile/android/app/MainActivity.kt"]).mobileNative,
    false,
  );
  assert.equal(
    classifyChangedPaths(["apps/mobile/modules/example/ios/Example.swift"]).mobileNative,
    true,
  );
  assert.equal(classifyChangedPaths(["apps/mobile/Brewfile"]).mobileNative, true);
  assert.equal(classifyChangedPaths(["apps/mobile/.editorconfig"]).mobileNative, true);
  assert.equal(
    classifyChangedPaths(["apps/mobile/modules/example/.editorconfig"]).mobileNative,
    true,
  );
  assert.equal(classifyChangedPaths(["apps/.editorconfig"]).mobileNative, true);
  assert.equal(classifyChangedPaths([".editorconfig"]).mobileNative, true);
  assert.equal(classifyChangedPaths(["scripts/mobile-native-static-check.ts"]).mobileNative, true);
  assert.equal(classifyChangedPaths(["packages/shared/src/shell.ts"]).mobileNative, true);
});

test("runs release smoke only for release inputs", () => {
  assert.equal(classifyChangedPaths(["apps/web/src/main.tsx"]).releaseSmoke, false);
  assert.equal(classifyChangedPaths(["docs/package.json"]).releaseSmoke, false);
  assert.equal(classifyChangedPaths([".repos/example/package.json"]).releaseSmoke, false);
  for (const file of [
    "pnpm-lock.yaml",
    "apps/web/package.json",
    "patches/example.patch",
    "scripts/release-smoke.ts",
    "scripts/update-release-package-versions.ts",
    "scripts/resolve-nightly-release.ts",
    "scripts/merge-update-manifests.ts",
    "scripts/lib/update-manifest.ts",
    "packages/shared/src/schemaJson.ts",
    "apps/mobile/deps/example.tgz",
  ]) {
    assert.equal(classifyChangedPaths([file]).releaseSmoke, true, file);
  }
});

test("classifies every pull request file and writes string outputs", async () => {
  const outputs = {};
  const listFiles = () => {};
  await run({
    github: {
      paginate: async (method, input) => {
        assert.equal(method, listFiles);
        assert.equal(input.pull_number, 42);
        return [{ filename: "docs/user/install.md" }, { filename: ".github/VOUCHED.td" }];
      },
      rest: { pulls: { listFiles } },
    },
    context: {
      eventName: "pull_request",
      payload: { pull_request: { number: 42 } },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.deepEqual(outputs, {
    check: "false",
    full_check: "false",
    test: "false",
    mobile_native: "false",
    release_smoke: "false",
  });
});

test("classifies both sides of a renamed file", async () => {
  const outputs = {};
  const listFiles = () => {};
  await run({
    github: {
      paginate: async () => [
        {
          filename: "docs/old-component.md",
          previous_filename: "apps/web/src/old-component.tsx",
        },
      ],
      rest: { pulls: { listFiles } },
    },
    context: {
      eventName: "pull_request",
      payload: { pull_request: { number: 42 } },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.equal(outputs.test, "true");
});

test("classifies files in a push to main", async () => {
  const outputs = {};
  const compareCommitsWithBasehead = async (input) => {
    assert.equal(input.basehead, "before...after");
    return { data: { files: [{ filename: "docs/user/install.md" }] } };
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

  assert.equal(outputs.test, "false");
  assert.equal(outputs.release_smoke, "false");
});

test("fails safe when a push comparison reaches GitHub's file limit", async () => {
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
  assert.equal(outputs.mobile_native, "true");
  assert.equal(outputs.release_smoke, "true");
});

test("fails safe when a pull request reaches GitHub's file limit", async () => {
  const outputs = {};
  const listFiles = () => {};
  await run({
    github: {
      paginate: async () =>
        Array.from({ length: 3_000 }, (_, index) => ({ filename: `docs/example-${index}.md` })),
      rest: { pulls: { listFiles } },
    },
    context: {
      eventName: "pull_request",
      payload: { pull_request: { number: 42 } },
      repo: { owner: "pingdotgg", repo: "t3code" },
    },
    core: { setOutput: (key, value) => (outputs[key] = value) },
  });

  assert.equal(outputs.test, "true");
  assert.equal(outputs.mobile_native, "true");
  assert.equal(outputs.release_smoke, "true");
});

test("runs gates when a successful classifier omits an output", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  for (const output of ["check", "test", "mobile_native", "release_smoke"]) {
    assert.match(workflow, new RegExp(`outputs\\.${output} != 'false'`));
  }
  assert.match(workflow, /outputs\.full_check != 'false'/);
  assert.doesNotMatch(workflow, /outputs\.[a-z_]+ == 'true'/);
  assert.equal(workflow.match(/!cancelled\(\) &&/g)?.length, 4);
});
