const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { setMobileVersion } = require("./set-mobile-version.cjs");
const { RELEASE_PACKAGE_FILES, setReleaseVersion } = require("./set-release-version.cjs");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");

function jobs(path) {
  const body = read(path).split(/^jobs:\n/m)[1];
  const found = {};
  for (const block of body.split(/^(?=  [\w-]+:\n)/m)) {
    const name = /^  ([\w-]+):\n/.exec(block)?.[1];
    if (name) found[name] = block;
  }
  return found;
}

const steps = (block) => block.split(/^ {4,6}- /m).slice(1);
const runsProjectCode = (block) =>
  /setup-vp@|setup-ci-deps|eas-local-build|expo-github-action|\b(?:vp|pnpm|npm|npx|eas) /.test(
    block,
  );

test("npm publishing is bound to the environment that admits only main and v* tags", () => {
  const publish = jobs("workflows/release.yml").publish_cli;
  assert.match(publish, /^ {6}id-token: write$/m);
  assert.match(publish, /^ {4}environment: production$/m);
});

test("the web preview gives the Vercel token to the deploy step only, after an install without lifecycle scripts", () => {
  const deploy = jobs("workflows/web-preview.yml").deploy;
  assert.doesNotMatch(deploy.split(/^ {4}steps:\n/m)[0], /secrets\./);
  const withSecrets = steps(deploy).filter((step) => step.includes("secrets."));
  assert.equal(withSecrets.length, 1);
  assert.match(withSecrets[0], /name: Deploy preview/);
  assert.match(deploy, /run-install: \|\n {12}args:\n {14}- --ignore-scripts\n/);
});

const mobileWorkflows = [
  "workflows/mobile-eas-preview.yml",
  "workflows/mobile-eas-preview-build.yml",
  "workflows/mobile-eas-production.yml",
  "workflows/mobile-eas-production-build.yml",
];

for (const path of mobileWorkflows) {
  test(`${path}: no job that installs or builds can push to the repository`, () => {
    for (const [name, block] of Object.entries(jobs(path))) {
      if (/^ {4}uses: /m.test(block)) continue;
      const writes = /contents: write|write-all|record-build-tag|create-github-app-token/.test(
        block,
      );
      assert.match(block, /^ {4}permissions:\n/m, `${name} declares its permissions`);
      assert.ok(!(writes && runsProjectCode(block)), `${name} holds a write token and runs code`);
    }
  });
}

test("the build record is pushed by the record job of each build workflow", () => {
  for (const path of [
    "workflows/mobile-eas-preview-build.yml",
    "workflows/mobile-eas-production-build.yml",
  ]) {
    const { record, ...builds } = jobs(path);
    assert.match(record, /uses: \.\/\.github\/actions\/record-build-tag/);
    assert.match(record, /^ {6}contents: write/m);
    for (const block of Object.values(builds)) assert.match(block, /^ {6}contents: read$/m);
  }
});

test("jobs that push run this workflow's own actions", () => {
  for (const file of mobileWorkflows) {
    for (const [name, block] of Object.entries(jobs(file))) {
      if (!/contents: write|create-github-app-token/.test(block)) continue;
      const jobSteps = steps(block);
      const checkout = jobSteps.findIndex((step) => /^ +ref: .*\b(?:inputs|needs)\./m.test(step));
      if (checkout === -1) continue;
      const local = jobSteps.slice(checkout).filter((step) => /^ +uses: \.\//m.test(step));
      assert.equal(local.length, 0, `${file} ${name} runs a local action from another checkout`);
    }
  }
});

const recordScript = read("actions/record-build-tag/action.yml")
  .split(/^ {6}run: \|\n/m)[1]
  .replace(/^ {8}/gm, "")
  .replace(/^remote=.*$/m, 'remote="$TEST_REMOTE"');

function recordTag(commitOf, failedFetches = 0) {
  const directory = mkdtempSync(join(tmpdir(), "t3-record-tag-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const remote = join(directory, "remote.git");
    const work = join(directory, "work");
    git(directory, "init", "--quiet", "--bare", remote);
    git(directory, "init", "--quiet", "--initial-branch=main", work);
    const commit = (message) => {
      git(
        work,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
      );
      return git(work, "rev-parse", "HEAD");
    };
    const shas = { first: commit("first") };
    shas.head = commit("second");
    git(work, "push", "--quiet", remote, "main");
    git(work, "checkout", "--quiet", "--detach");
    shas.elsewhere = commit("not on main");
    git(work, "push", "--quiet", remote, "HEAD:refs/heads/other");
    git(work, "checkout", "--quiet", "main");
    // The first fetches fail, and the waits between attempts are skipped.
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\nif [ "$1" = fetch ] && [ "$(wc -l < "$FETCHES")" -lt "$FAILED_FETCHES" ]; then echo x >> "$FETCHES"; exit 1; fi\nexec "$REAL_GIT" "$@"\n`,
    );
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\n");
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(join(directory, "fetches"), "");
    const result = spawnSync("bash", ["-c", recordScript], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        REAL_GIT: execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
        FETCHES: join(directory, "fetches"),
        FAILED_FETCHES: String(failedFetches),
        HOME: directory,
        TEST_REMOTE: remote,
        GITHUB_REF: "refs/heads/main",
        TAG: "build/1",
        MESSAGE: "",
        REPLACE: "false",
        COMMIT: commitOf(shas),
      },
    });
    const tagged = git(directory, "ls-remote", remote, "refs/tags/build/1").split(/\s/)[0];
    return { status: result.status, tagged, shas };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the build record tags the named commit only when it is on the workflow's ref", () => {
  const onRef = recordTag((shas) => shas.first);
  assert.deepEqual([onRef.status, onRef.tagged], [0, onRef.shas.first]);
  const retried = recordTag((shas) => shas.first, 2);
  assert.deepEqual([retried.status, retried.tagged], [0, retried.shas.first]);
  assert.equal(recordTag((shas) => shas.first, 3).status, 1);
  const head = recordTag(() => "");
  assert.deepEqual([head.status, head.tagged], [0, head.shas.head]);
  for (const commitOf of [(shas) => shas.elsewhere, () => "main", () => "0".repeat(40)]) {
    const refused = recordTag(commitOf);
    assert.deepEqual([refused.status, refused.tagged], [1, ""]);
  }
});

test("the store build record job runs the workflow's own action and passes the built commit as data", () => {
  const { record } = jobs("workflows/mobile-eas-production-build.yml");
  assert.doesNotMatch(record, /^ +ref: /m);
  assert.match(record, /^ {10}commit: \$\{\{ inputs\.sha \}\}$/m);
});

test("release deploys give the Vercel token to the deploy step only", () => {
  const all = jobs("workflows/release.yml");
  for (const name of ["build_web", "build_marketing"]) {
    assert.doesNotMatch(all[name].split(/^ {4}steps:\n/m)[0], /secrets\.VERCEL/);
    const withToken = steps(all[name]).filter((step) => step.includes("secrets.VERCEL_TOKEN"));
    assert.equal(withToken.length, 1);
    assert.match(withToken[0], /name: Build staged deployment/);
  }
});

test("the version override token covers this repository only", () => {
  const { version, production } = jobs("workflows/mobile-eas-production.yml");
  const mint = steps(version).find((step) => step.includes("create-github-app-token"));
  assert.doesNotMatch(mint, /^\s+(?:owner|repositories):/m);
  assert.match(mint, /^\s+permission-contents: write$/m);
  assert.doesNotMatch(production, /RELEASE_APP|create-github-app-token/);
});

test("the release version bump is pushed by a job that installs nothing, with a token for this repository only", () => {
  const { finalize } = jobs("workflows/release.yml");
  const mint = steps(finalize).find((step) => step.includes("create-github-app-token"));
  assert.doesNotMatch(mint, /^\s+(?:owner|repositories):/m);
  assert.match(mint, /^\s+permission-contents: write$/m);
  assert.ok(!runsProjectCode(finalize), "finalize holds a write token and runs code");
  assert.match(finalize, /run: node \.github\/scripts\/set-release-version\.cjs /);
});

test("the Vite+ toolchain is cached before the job installs or runs project code", () => {
  const names = Array.from(
    read("actions/setup-ci-deps/action.yml").matchAll(
      /^ {4}- name: (.+)\n(?: {6}.*\n)*? {6}uses: (\S+)|^ {4}- name: (.+)$/gm,
    ),
    (match) => ({ name: match[1] ?? match[3], uses: match[2] ?? "" }),
  );
  const index = (name) => names.findIndex((step) => step.name === name);
  assert.match(names[index("Restore Vite+")].uses, /^actions\/cache\/restore@/);
  assert.match(names[index("Save Vite+")].uses, /^actions\/cache\/save@/);
  assert.ok(index("Save Vite+") < index("Resolve pnpm store"));
  assert.ok(index("Save Vite+") < index("Install dependencies"));
  // The combined action saves at the end of the job, after everything ran.
  assert.ok(names.every((step) => !step.uses.startsWith("actions/cache@")));
});

const consumeScript = steps(jobs("workflows/mobile-eas-preview-fork.yml").preview)
  .find((step) => step.startsWith("id: consume\n"))
  .split(/^ {10}script: \|\n/m)[1]
  .replace(/^ {12}/gm, "");
const consume = new (Object.getPrototypeOf(async () => {}).constructor)(
  "github",
  "context",
  "core",
  consumeScript,
);

async function runConsume(permission, removeStatus, removed = []) {
  const outputs = {};
  await consume(
    {
      rest: {
        repos: {
          async getCollaboratorPermissionLevel({ username }) {
            assert.equal(username, "labeler");
            if (permission === undefined) throw Object.assign(new Error("denied"), { status: 403 });
            return { data: { permission } };
          },
        },
        issues: {
          async removeLabel(params) {
            if (removeStatus) throw Object.assign(new Error("gone"), { status: removeStatus });
            removed.push(params.name);
          },
        },
      },
    },
    {
      repo: { owner: "example", repo: "app" },
      payload: {
        sender: { login: "labeler" },
        label: { name: "deploy" },
        pull_request: { number: 7 },
      },
    },
    { info() {}, warning() {}, setOutput: (name, value) => (outputs[name] = value) },
  );
  return { outputs, removed };
}

for (const [permission, consumed] of [
  ["admin", "true"],
  ["maintain", "true"],
  ["write", "true"],
  ["triage", "false"],
  ["read", "false"],
  ["none", "false"],
]) {
  test(`a fork preview label from ${permission} access is removed and ${consumed === "true" ? "builds" : "builds nothing"}`, async () => {
    assert.deepEqual(await runConsume(permission), {
      outputs: { consumed },
      removed: ["deploy"],
    });
  });
}

test("a fork preview label is removed even when the access lookup fails", async () => {
  const removed = [];
  await assert.rejects(runConsume(undefined, undefined, removed), { status: 403 });
  assert.deepEqual(removed, ["deploy"]);
});

test("a fork preview label removed before the run builds nothing", async () => {
  assert.deepEqual(await runConsume("admin", 404), { outputs: { consumed: "false" }, removed: [] });
});

test("a version override rewrites only the app version", () => {
  const config = read("../apps/mobile/app.config.ts");
  const next = setMobileVersion(config, "9.8.7");
  assert.match(next, /^ {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? "9\.8\.7",$/m);
  assert.equal(setMobileVersion(next, "9.8.7"), next);
  assert.deepEqual(
    next.split("\n").filter((line, index) => line !== config.split("\n")[index]).length,
    1,
  );
  for (const version of ["", "1", "1.2.3.4", "1.2-beta", '1.2", extra: "x']) {
    assert.throws(() => setMobileVersion(config, version), /two or three dot-separated integers/);
  }
  assert.throws(() => setMobileVersion("export default {};", "1.2.3"), /Could not update/);
});

test("a release version bump rewrites only the version of each release manifest", () => {
  const listed = /releasePackageFiles = \[\n([^\]]+)\]/.exec(
    read("../scripts/lib/tagged-source-version.ts"),
  )[1];
  assert.deepEqual(
    RELEASE_PACKAGE_FILES,
    Array.from(listed.matchAll(/"([^"]+)"/g), (m) => m[1]),
  );
  for (const file of RELEASE_PACKAGE_FILES) {
    const manifest = read(`../${file}`);
    const next = setReleaseVersion(manifest, "98.7.6");
    assert.equal(JSON.parse(next).version, "98.7.6");
    assert.deepEqual(
      { ...JSON.parse(next), version: "" },
      { ...JSON.parse(manifest), version: "" },
    );
    assert.equal(setReleaseVersion(next, "98.7.6"), next);
    assert.deepEqual(
      next.split("\n").filter((line, index) => line !== manifest.split("\n")[index]).length,
      1,
    );
  }
  for (const version of ["", "1", "1.2", "v1.2.3", '1.2.3", "x": "y']) {
    assert.throws(() => setReleaseVersion('{\n  "version": "1.0.0"\n}\n', version), /Invalid/);
  }
  assert.equal(
    setReleaseVersion('{\n  "version": "1.0.0"\n}\n', "1.2.3-rc.1"),
    '{\n  "version": "1.2.3-rc.1"\n}\n',
  );
  assert.throws(() => setReleaseVersion('{\n  "name": "x"\n}\n', "1.2.3"), /exactly one/);
});
