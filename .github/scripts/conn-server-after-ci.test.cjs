const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const { select } = require("./conn-server-after-ci.cjs");

const workflowFile = (file) => readFileSync(path.join(__dirname, "../workflows", file), "utf8");
const workflow = workflowFile("conn-server-after-ci.yml");
const before = "a".repeat(40);
const after = "b".repeat(40);
const latest = "c".repeat(40);
const companionRun = 200;
const repo = { owner: "nckrtl", repo: "conn" };
const original = {
  event: "push",
  head_branch: "main",
  head_repository: { id: 42 },
  head_sha: after,
  path: ".github/workflows/ci.yml",
  run_attempt: 1,
  id: 123,
  check_suite_id: 456,
  created_at: "2026-11-18T00:14:16Z",
};

test("only the initial completion of CI for a push to Conn main admits the selector", () => {
  assert.match(workflow, /workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]/);
  const condition = workflow.match(/    if: >-\n((?:^ {6}[^\n]+\n)+)/m)?.[1];
  assert.ok(condition);
  const selects = (run, repository = "nckrtl/conn") =>
    runInNewContext(condition, {
      github: { repository, event: { repository: { id: 42 }, workflow_run: run } },
    });
  for (const conclusion of ["success", "failure", "cancelled", "skipped"]) {
    assert.equal(selects({ ...original, conclusion }), true);
  }
  for (const patch of [
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "sync/upstream" },
    { head_repository: { id: 99 } },
    { path: ".github/workflows/other.yml" },
    { run_attempt: 2 },
  ]) {
    assert.equal(selects({ ...original, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(selects(original, "pingdotgg/t3code"), false);
});

test("fan-out waits for selection, pins every checkout and keeps native PR, sync and manual runs", () => {
  assert.match(workflow, /needs: select\n    if: needs\.select\.outputs\.checks == 'true'/);
  assert.match(workflow, /needs: select\n    if: needs\.select\.outputs\.musl == 'true'/);
  assert.match(workflow, /source_sha: \$\{\{ needs\.select\.outputs\.source_sha \}\}/);
  for (const file of ["conn-server-checks.yml", "conn-server-ci.yml"]) {
    const companion = workflowFile(file);
    assert.match(companion, /pull_request:\n    paths: &paths/);
    assert.match(companion, /push:\n    branches:\n      - "sync\/\*\*"\n    paths: \*paths/);
    assert.match(companion, /workflow_dispatch:/);
    const group = companion.match(/^  group: (.+)$/m);
    assert.ok(group);
    const key = (runId) =>
      group[1].replace(/\$\{\{ (.+?) \}\}/g, (_, expr) =>
        runInNewContext(expr, {
          github: { event_name: "workflow_run", sha: latest, run_id: runId },
          inputs: { source_sha: after },
          format: (pattern, value) => pattern.replace("{0}", value),
        }),
      );
    assert.notEqual(key(companionRun), key(companionRun + 1));
    assert.equal(
      companion.match(/- name: Checkout\n/g).length,
      companion.match(/ref: \$\{\{ inputs\.source_sha \}\}/g).length,
    );
    const saves = [...companion.matchAll(/- name: Save [^\n]+\n        if: ([^\n]+)/g)];
    assert.equal(saves.length, file === "conn-server-checks.yml" ? 3 : 1);
    for (const [, condition] of saves) {
      const savesCache = (eventName, ref, cacheHit = "false", profile = "release") =>
        runInNewContext(condition.replace(/\.([a-z]+-[a-z]+)/g, '["$1"]'), {
          github: { event_name: eventName, ref },
          inputs: { source_sha: after },
          steps: {
            "cargo-cache": { outputs: { "cache-hit": cacheHit } },
            "pnpm-cache": { outputs: { "cache-hit": cacheHit } },
          },
          matrix: { profile },
        });
      assert.equal(savesCache("workflow_run", "refs/heads/main"), true);
      assert.equal(savesCache("workflow_run", "refs/heads/main", "true"), false);
      assert.equal(savesCache("pull_request", "refs/pull/1/merge"), false);
      assert.equal(savesCache("push", "refs/heads/sync/upstream"), false);
      assert.equal(savesCache("workflow_dispatch", "refs/heads/main"), false);
      if (condition.includes("matrix.profile")) {
        assert.equal(savesCache("workflow_run", "refs/heads/main", "false", "debug"), false);
      }
    }
  }
});

function selectionFixture({
  run = original,
  base = before,
  files = [],
  totalCommits = 2,
  mergeBase = base,
  suite = {},
  diff = () => assert.fail("unexpected Git fallback"),
  compareError = null,
} = {}) {
  const outputs = {};
  const warnings = [];
  const trigger = {
    github: {
      rest: {
        checks: {
          getSuite: async (args) => {
            assert.deepEqual(args, { ...repo, check_suite_id: run.check_suite_id });
            return {
              data: {
                before: base,
                after: run.head_sha,
                head_sha: run.head_sha,
                head_branch: "main",
                repository: run.head_repository,
                ...suite,
              },
            };
          },
        },
        repos: {
          compareCommitsWithBasehead: async (args) => {
            assert.deepEqual(args, { ...repo, basehead: `${base}...${run.head_sha}`, per_page: 1 });
            if (compareError) throw compareError;
            return {
              data: {
                total_commits: totalCommits,
                merge_base_commit: { sha: mergeBase },
                files: files.map((file) => (typeof file === "string" ? { filename: file } : file)),
              },
            };
          },
        },
      },
    },
    context: { repo, sha: latest, payload: { workflow_run: run } },
    core: {
      info: () => {},
      warning: (warning) => warnings.push(warning),
      setOutput: (key, value) => (outputs[key] = value),
    },
    diff,
  };
  return { run: () => select(trigger), outputs, warnings };
}

test("path selection uses the net multi-commit push range and each original workflow's paths", async () => {
  for (const [files, checks, musl] of [
    [["docs/operations/development.md"], "false", "false"],
    [["apps/desktop/package.json"], "false", "false"],
    [["apps/server/src/bin.ts", "docs/internals/testing.md"], "true", "false"],
    [["apps/web/src/main.tsx"], "true", "false"],
    [["packages/shared/package.json"], "true", "false"],
    [["apps/conn-server/Cargo.lock"], "true", "true"],
    [[".github/workflows/conn-server-checks.yml"], "true", "true"],
    [[".github/workflows/conn-server-ci.yml"], "true", "true"],
    [[], "false", "false"],
  ]) {
    const fixture = selectionFixture({ files });
    await fixture.run();
    assert.deepEqual(fixture.outputs, { source_sha: after, checks, musl });
  }
});

test("rename selection counts both endpoints of the push diff", async (t) => {
  const docs = "docs/server.md";
  for (const [path, musl] of [
    ["apps/server/src/bin.ts", "false"],
    ["apps/conn-server/Cargo.lock", "true"],
    [".github/workflows/conn-server-ci.yml", "true"],
  ]) {
    for (const [previous_filename, filename] of [
      [path, docs],
      [docs, path],
    ]) {
      await t.test(`${previous_filename} → ${filename}`, async () => {
        const fixture = selectionFixture({
          files: [{ status: "renamed", previous_filename, filename }],
        });
        await fixture.run();
        assert.deepEqual(fixture.outputs, { source_sha: after, checks: "true", musl });
      });
    }
  }
  const fixture = selectionFixture({
    files: [{ status: "renamed", previous_filename: docs, filename: "docs/new.md" }],
  });
  await fixture.run();
  assert.deepEqual(fixture.outputs, { source_sha: after, checks: "false", musl: "false" });
});

test("two rapid pushes select independently while the default tip is already newer", async () => {
  const first = selectionFixture({ files: ["packages/shared/package.json"] });
  const second = selectionFixture({
    base: after,
    run: { ...original, head_sha: latest, id: 124, check_suite_id: 457 },
    files: ["docs/operations/development.md"],
  });
  await Promise.all([second.run(), first.run()]);
  assert.deepEqual(first.outputs, { source_sha: after, checks: "true", musl: "false" });
  assert.deepEqual(second.outputs, { source_sha: latest, checks: "false", musl: "false" });
});

test("unavailable diffs and huge pushes fail open while a mismatched check suite is rejected", async () => {
  for (const options of [{ compareError: new Error("timeout") }, { totalCommits: 1001 }]) {
    const fixture = selectionFixture(options);
    await fixture.run();
    assert.deepEqual(fixture.outputs, { source_sha: after, checks: "true", musl: "true" });
  }
  const fixture = selectionFixture({ suite: { after: latest } });
  await assert.rejects(fixture.run(), /original main push range/);
  assert.deepEqual(fixture.outputs, {});
});

test("a non-fast-forward comparison falls back to the two exact push endpoints", async () => {
  const fixture = selectionFixture({
    mergeBase: "d".repeat(40),
    files: ["apps/conn-server/Cargo.lock"],
    diff: (base, head) => {
      assert.equal(base, before);
      assert.equal(head, after);
      return ["docs/operations/development.md"];
    },
  });
  await fixture.run();
  assert.deepEqual(fixture.outputs, { source_sha: after, checks: "false", musl: "false" });
});

const resultJob = workflow.split("\n  result:\n")[1];
const reportScript = resultJob.match(/          script: \|\n([\s\S]+)$/)?.[1];
const checksName = "Conn Server checks";
const muslName = "Linux musl release build";
const actionsApp = { slug: "github-actions" };

function reportFixture() {
  const records = [];
  let loseResponseFor;
  const checks = {
    listForRef: () => assert.fail("expected pagination"),
    create: async ({ owner, repo: repoName, ...check }) => {
      assert.deepEqual({ owner, repo: repoName }, repo);
      const id = records.length + 1;
      records.push({ ...check, id, app: actionsApp });
      if (check.name === loseResponseFor) {
        loseResponseFor = undefined;
        throw new Error("lost create response");
      }
    },
    update: async ({ owner, repo: repoName, check_run_id, ...check }) => {
      assert.deepEqual({ owner, repo: repoName }, repo);
      assert.ok(!("head_sha" in check), "update cannot change the selected SHA");
      const record = records.find(({ id }) => id === check_run_id);
      assert.ok(record, "update must target an existing check");
      Object.assign(record, check);
    },
  };
  const summary = { addRaw: () => summary, write: async () => {} };
  return {
    records,
    loseCreateResponse: (name) => (loseResponseFor = name),
    report: ({
      source = original,
      number = 10,
      attempt = 1,
      runId = companionRun,
      checksResult = "success",
      musl = "true",
      muslResult = "success",
    } = {}) =>
      runInNewContext(`(async () => { ${reportScript} })()`, {
        github: {
          rest: { checks },
          paginate: async (method, args) => {
            assert.equal(method, checks.listForRef);
            assert.deepEqual({ ...args }, { ...repo, ref: after, filter: "all", per_page: 100 });
            return records.filter((record) => record.head_sha === args.ref);
          },
        },
        core: { info: () => {}, summary },
        context: {
          repo,
          sha: latest,
          payload: { workflow_run: source },
          serverUrl: "https://github.com",
          runId,
        },
        process: {
          env: {
            SOURCE_SHA: after,
            CHECKS_RESULT: checksResult,
            MUSL_SELECTED: musl,
            MUSL_RESULT: muslResult,
            GITHUB_RUN_NUMBER: String(number),
            GITHUB_RUN_ATTEMPT: String(attempt),
          },
        },
        Date: { now: () => Date.parse("2026-11-18T00:25:16Z"), parse: Date.parse },
      }),
  };
}

test("the publisher reports a failed companion on the old SHA and omits an unselected musl check", async () => {
  assert.match(resultJob, /needs: \[select, checks, musl\]/);
  assert.match(resultJob, /always\(\) && needs\.select\.result == 'success'/);
  assert.doesNotMatch(resultJob, /actions\/checkout|actions\/download-artifact/);
  assert.ok(reportScript);
  const { records, report } = reportFixture();
  await report({ checksResult: "failure", musl: "false" });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, checksName);
  assert.equal(records[0].head_sha, after);
  assert.equal(records[0].conclusion, "failure");
  assert.match(records[0].output.summary, /660s elapsed from push/);
});

test("retry adopts checks created before a partial publication failure", async () => {
  const { records, report, loseCreateResponse } = reportFixture();
  loseCreateResponse(checksName);
  await assert.rejects(report({ checksResult: "failure" }), /lost create response/);
  assert.deepEqual(
    records.map(({ name, conclusion }) => [name, conclusion]),
    [[checksName, "failure"]],
  );
  await report({ checksResult: "failure", muslResult: "failure" });
  assert.deepEqual(
    records.map(({ id, conclusion }) => [id, conclusion]),
    [
      [1, "failure"],
      [2, "failure"],
    ],
  );
  await report({ attempt: 2, muslResult: "failure" });
  await report({ attempt: 2, muslResult: "failure" });
  assert.deepEqual(
    records.map(({ id, name, conclusion }) => [id, name, conclusion]),
    [
      [1, checksName, "success"],
      [2, muslName, "failure"],
    ],
  );
  assert.match(records[0].details_url, /\/runs\/200\/attempts\/2$/);
  assert.match(records[1].details_url, /\/runs\/200\/attempts\/2$/);
});

test("an older queued publication cannot replace a later result or fill its missing gate", async () => {
  const { records, report, loseCreateResponse } = reportFixture();
  loseCreateResponse(checksName);
  await assert.rejects(report({ number: 11, runId: 201 }), /lost create response/);
  await report({ attempt: 3, checksResult: "failure", muslResult: "failure" });
  assert.deepEqual(
    records.map(({ name, conclusion }) => [name, conclusion]),
    [[checksName, "success"]],
  );
  await report({ number: 11, runId: 201, attempt: 2 });
  await report({ number: 11, runId: 201, checksResult: "failure", muslResult: "failure" });
  assert.deepEqual(
    records.map(({ id, name, conclusion }) => [id, name, conclusion]),
    [
      [1, checksName, "success"],
      [2, muslName, "success"],
    ],
  );
  assert.match(records[0].details_url, /\/runs\/201\/attempts\/2$/);
});

test("same-SHA pushes have distinct reports and leave native and foreign checks alone", async () => {
  const { records, report } = reportFixture();
  await report({ musl: "false" });
  const [own] = records;
  const native = { ...own, id: 2, external_id: "native-job", conclusion: "neutral" };
  const foreign = { ...own, id: 3, app: { slug: "other-app" }, conclusion: "neutral" };
  records.push(native, foreign);
  const snapshots = records.slice(1).map((record) => ({ ...record }));
  const secondPush = { ...original, id: 124, check_suite_id: 457 };
  await report({ source: secondPush, number: 11, runId: 201, musl: "false" });
  await report({ attempt: 2, checksResult: "failure", musl: "false" });
  assert.deepEqual(records.slice(1, 3), snapshots);
  assert.deepEqual(
    records.map(({ id, conclusion }) => [id, conclusion]),
    [
      [1, "failure"],
      [2, "neutral"],
      [3, "neutral"],
      [4, "success"],
    ],
  );
  assert.notEqual(records[0].external_id, records[3].external_id);
});

test("publication queues overlapping retries by source run, including distinct pushes of one SHA", () => {
  const group = resultJob.match(/    concurrency:\n      group: (.+)\n      queue: max\n/);
  assert.ok(group);
  const groupFor = (run) =>
    group[1].replace(/\$\{\{ (.+?) \}\}/g, (_, expr) =>
      runInNewContext(expr, { github: { event: { workflow_run: run } } }),
    );
  assert.equal(groupFor(original), groupFor({ ...original, run_attempt: 2 }));
  assert.notEqual(groupFor(original), groupFor({ ...original, id: 124 }));
});
