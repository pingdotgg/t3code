// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  chunkByCommandLength,
  comparisonBase,
  defaultConcurrency,
  docReaderTests,
  gitLines,
  ignoredCheckInputs,
  runSteps,
  splitTests,
  type Step,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("runs the server tests for the one guide they read and leaves other docs inert", () => {
    const packages = readWorkspace();
    assert.isTrue(
      decide(["docs/user/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    );
    assert.deepStrictEqual(docReaderTests(["docs/user/t3-connect-troubleshooting.md"]), [
      "apps/server/src/cloud/ConnectReachability.test.ts",
    ]);
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\thread-transfer-report.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [
          ".github/scripts/ci-changes.test.cjs",
          ".github\\scripts\\thread-transfer-report.test.cjs",
        ],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files.
const fixtureConfig = {
  "core.excludesFile": NodeOS.devNull,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const compare = (root: string, ref: Option.Option<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* comparisonBase(root, ref).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

function launcherFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    ".github/scripts/ci-changes.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  write(".gitignore", "node_modules/\nrecords/\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "package.json",
    JSON.stringify({ type: "module", scripts: { "knip:check": "knip --include files" } }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    process.exit(args[0] === process.env.FAIL_STEP ? 23 : 0);
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
      "vitePlusCommand(args, platform)",
      'vitePlusCommand(args, "win32")',
    ),
  );
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  return {
    root,
    source,
    write,
    run(failStep = "") {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, TEMP: NodeOS.tmpdir(), RECORDS: records, FAIL_STEP: failStep },
      });
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "install")).toBe(false);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  expect(calls.some(({ args }) => args[0] === "exec" && args[1] === "knip")).toBe(true);
});

it.each(["install", "lint"])("reports a failing %s step with its output", (step) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(step);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[0] === "install");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${step}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${step}`);
  expect(result.stdout).toContain(step === "install" ? "FAIL  unused patches" : "FAIL  lint");
  if (step === "lint") expect(result.stdout).toContain("pass  unused patches");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

// The command that listed ignored inputs before ignoredCheckInputs: a pathspec-filtered walk
// of every ignored directory. `-z` only changes how git delimits and quotes paths, not
// which paths it selects.
const walkedIgnoredInputs = (git: (...args: Array<string>) => string) =>
  git(
    "-c",
    "core.quotePath=false",
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":(glob)**/.generated/**",
    ":(glob)**/.astro/**",
    ":(glob)**/*.d.ts",
    ":(glob)**/.env*",
    ":(exclude,glob)**/node_modules/**",
  )
    .split("\0")
    .filter(Boolean)
    .sort();

// Runs ignoredCheckInputs on a repository, recording the git commands it starts.
const listIgnoredInputs = (root: string, gitEnv: Record<string, string>, budget?: number) => {
  const calls: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const listed = yield* ignoredCheckInputs(root, budget).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand") calls.push(command.args.map(String));
          return spawner.spawn(ChildProcess.setEnv(command, gitEnv));
        }),
      ),
    );
    return { listed, calls };
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
};

// An empty global config: git for Windows rejects the NUL device as a config path.
const withIgnoredFixture = async (
  body: (fixture: {
    root: string;
    gitEnv: Record<string, string>;
    git: (...args: Array<string>) => string;
    write: (file: string, content?: string) => void;
  }) => Promise<void>,
) => {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ignored-inputs-")),
  );
  const root = NodePath.join(dir, "repo");
  const globalConfig = NodePath.join(dir, "gitconfig");
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: globalConfig };
  try {
    NodeFS.writeFileSync(globalConfig, "");
    const write = (file: string, content = file) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv });
    await body({ root, gitEnv, git, write });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

it("lists ignored generated, declaration, and env files without entering node_modules", async () => {
  await withIgnoredFixture(async ({ root, gitEnv, git, write }) => {
    write(
      ".gitignore",
      "node_modules/\ndist/\ndist_old/\n.astro\n.env*\n!.env.example\n/.generated/\napps/*/.generated/\n*.log\n",
    );
    // Enough tracked packages, each with an ignored dist/, for several expansion calls.
    const packages = Array.from({ length: 60 }, (_, i) => `many/p${i}`);
    for (const file of [
      "src/a.ts",
      "src/tracked.d.ts",
      "apps/web/.env.example",
      "packages/replaced/dist",
      "sib/tracked.ts",
      "vendor/lib/a.ts",
      ...packages.map((pkg) => `${pkg}/src.ts`),
    ])
      write(file);
    git("init");
    git("add", "-f", ".");
    git("commit", "-m", "init");
    // A tracked file replaced by an ignored directory: ls-files hides the directory.
    NodeFS.rmSync(NodePath.join(root, "packages/replaced/dist"));
    // A nested repository in the tracked vendor/lib: git mishandles it as a pathspec prefix.
    git("init", "vendor/lib");
    for (const file of [
      "packages/replaced/dist/index.d.ts",
      "vendor/lib/dist/x.d.ts",
      // dist/ sorts right before dist_old/: a prefix test without the trailing
      // slash would take dist/ for its parent.
      "sib/dist/a.d.ts",
      "sib/dist_old/a.d.ts",
      ".generated/x.ts",
      ".generated/sub/y.d.ts",
      "apps/mobile/.generated/z.ts",
      "apps/web/.astro/types.d.ts",
      "apps/web/.astro/data.json",
      "packages/shared/dist/index.d.ts",
      "packages/shared/dist/deep/b.d.ts",
      "packages/shared/dist/readme.txt",
      ".env",
      ".env.local",
      "apps/x/.env.production",
      "src/debug.log",
      "src/new.d.ts",
      "apps/\u00fcn\u00ef/dist/\u00fc.d.ts",
      // Never listed: node_modules at any depth.
      "node_modules/pkg/index.d.ts",
      "node_modules/.generated/q.ts",
      "apps/web/node_modules/p/.env",
      "packages/shared/dist/node_modules/m/t.d.ts",
      "apps/web/node_modules/.astro/a.d.ts",
      // A package folder left behind by another branch: only ignored files, among them
      // its own node_modules. Its contents are listed with it, so it must not be walked.
      "stale/dist/x.d.ts",
      "stale/node_modules/pkg/index.d.ts",
      "stale/.env",
      // Listed: only a directory named node_modules is excluded, not a file.
      "apps/web/.astro/node_modules",
      ...packages.map((pkg) => `${pkg}/dist/index.d.ts`),
    ])
      write(file);
    // git quotes these in plain output; NTFS does not allow them.
    if (NodePath.sep === "/") {
      for (const file of ['dist/q"uote.d.ts', ".generated/ta\tb.ts", "back\\slash/dist/b.d.ts"])
        write(file);
    }

    const budget = 600;
    const { listed, calls } = await listIgnoredInputs(root, gitEnv, budget);

    // git is only asked to enter a directory by name, in batches that fit the budget, and
    // never one under node_modules or one whose contents the first listing already gave.
    const listings = calls.filter((args) => args.includes("ls-files") && !args.includes("-v"));
    const expansions = listings.filter((args) => !args.includes("--directory"));
    assert.strictEqual(listings.length, 1 + expansions.length);
    assert.isTrue(listings[0]!.includes("--directory"));
    assert.isAtLeast(expansions.length, 4);
    for (const args of expansions) {
      // The budget leaves room for `git -c core.quotePath=false`, the first two arguments.
      assert.isAtMost(
        args
          .slice(2)
          .map((arg) => `"${arg}"`)
          .join(" ").length,
        budget,
      );
      const pathspecs = args.slice(args.indexOf("--") + 1);
      assert.strictEqual(pathspecs[0], ":(literal).git/");
      assert.isFalse(pathspecs.some((spec) => spec.includes("node_modules")));
      assert.isFalse(pathspecs.includes(":(literal)stale/"));
      // A name is never read as a pattern, so git cannot be sent into a sibling by a `[1]`.
      assert.isTrue(pathspecs.every((spec) => spec.startsWith(":(literal)")));
    }

    const walked = walkedIgnoredInputs(git);
    assert.isAbove(walked.length, 10);
    for (const file of [
      "stale/dist/x.d.ts",
      "stale/.env",
      "apps/web/.astro/node_modules",
      "many/p59/dist/index.d.ts",
      "packages/replaced/dist/index.d.ts",
      "vendor/lib/dist/x.d.ts",
      "sib/dist/a.d.ts",
    ])
      assert.include(listed, file);
    assert.isFalse(listed.includes("stale/node_modules/pkg/index.d.ts"));
    assert.deepStrictEqual(listed, walked);
  });
});

it("lists what the old command listed for marked paths and ignored nested repositories", async () => {
  await withIgnoredFixture(async ({ root, gitEnv, git, write }) => {
    write(".gitignore", "node_modules/\ndist/\nvendored/\n.env*\n");
    for (const file of [
      "src/a.ts",
      "assume/dist",
      "skip/dist",
      "both/dist",
      "sparse/dist",
      "vendor/lib/a.ts",
    ])
      write(file);
    git("init");
    git("add", "-f", ".");
    git("commit", "-m", "init");
    git("update-index", "--assume-unchanged", "assume/dist");
    git("update-index", "--skip-worktree", "skip/dist");
    git("update-index", "--assume-unchanged", "--skip-worktree", "both/dist");
    // A tracked file that was never replaced, marked as a sparse checkout would.
    git("update-index", "--skip-worktree", "sparse/dist");
    const check = async () => {
      const { listed } = await listIgnoredInputs(root, gitEnv);
      assert.deepStrictEqual(listed, walkedIgnoredInputs(git));
      return listed;
    };
    // The only ignored directory, in a nested repository: one call, whose pathspecs would
    // share a prefix through that repository without the .git/ sentinel.
    git("init", "vendor/lib");
    write("vendor/lib/dist/x.d.ts");
    assert.deepStrictEqual(await check(), ["vendor/lib/dist/x.d.ts"]);

    // The old command lists a marked path's files, because it walks the directory.
    for (const file of ["assume/dist", "skip/dist", "both/dist"]) {
      NodeFS.rmSync(NodePath.join(root, file));
      write(`${file}/index.d.ts`, "export type A = string;");
    }
    const first = await check();
    for (const file of ["assume", "skip", "both"]) assert.include(first, `${file}/dist/index.d.ts`);
    assert.include(first, "vendor/lib/dist/x.d.ts");

    // An ignored nested repository changes the list when it is created or deleted: the old
    // command printed its directory, as the repository itself or inside an ignored folder.
    write("dist/x.d.ts");
    git("init", "dist");
    write("vendored/lib/y.d.ts");
    git("init", "vendored/lib");
    const withRepositories = await check();
    assert.include(withRepositories, "dist/");
    assert.include(withRepositories, "vendored/lib/");
    NodeFS.rmSync(NodePath.join(root, "dist/.git"), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.join(root, "vendored/lib/.git"), { recursive: true, force: true });
    const without = await check();
    assert.isFalse(without.includes("dist/"));
    assert.isFalse(without.includes("vendored/lib/"));
    assert.include(without, "dist/x.d.ts");
    assert.include(without, "vendored/lib/y.d.ts");
  });
});

describe("chunkByCommandLength", () => {
  // The quoted command line, as the longest form Windows would see it.
  const commandLine = (args: ReadonlyArray<string>) =>
    ["git", "-c", "core.quotePath=false", ...args]
      .map((arg) => `"${arg.replace(/(["\\])/g, "\\$1")}"`)
      .join(" ");
  const fixed = [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":(literal).git/",
  ];

  it("keeps long paths under the 32,767-unit command line limit, whatever their count", () => {
    // 80-character components, four deep: 340 characters a path, so 100 of them fill 35,000.
    const prefix = Array.from({ length: 4 }, (_, i) => String.fromCharCode(97 + i).repeat(80));
    const items = Array.from(
      { length: 100 },
      (_, i) => `:(literal)${prefix.join("/")}/p${String(i).padStart(3, "0")}/.generated/`,
    );
    assert.isAbove(commandLine([...fixed, ...items]).length, 32_767);
    const chunks = chunkByCommandLength(items, fixed);
    assert.isAbove(chunks.length, 1);
    assert.deepStrictEqual(chunks.flat(), items);
    for (const chunk of chunks)
      assert.isAtMost(commandLine([...fixed, ...chunk]).length, 32_767 - 2_000);
  });

  it("counts UTF-16 units, quotes and backslashes, and keeps short paths in one call", () => {
    const short = Array.from({ length: 300 }, (_, i) => `:(literal)many/p${i}/dist/`);
    assert.strictEqual(chunkByCommandLength(short, fixed).length, 1);
    // Three of each cost about 3,000 units apiece on the command line, so two fit in 7,000: an
    // emoji is two UTF-16 units, and a backslash or quote is written with an escape.
    for (const name of ["😀".repeat(1_495), "\\".repeat(1_495), '"'.repeat(1_495)]) {
      const wide = [1, 2, 3].map((n) => `:(literal)${name}${n}/`);
      const chunks = chunkByCommandLength(wide, fixed, 7_000);
      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.length),
        [2, 1],
      );
      for (const chunk of chunks) assert.isAtMost(commandLine([...fixed, ...chunk]).length, 7_000);
    }
    // A path longer than the budget still goes out, alone, instead of being dropped.
    assert.deepStrictEqual(chunkByCommandLength(["x".repeat(500), "y"], fixed, 100), [
      ["x".repeat(500)],
      ["y"],
    ]);
    assert.deepStrictEqual(chunkByCommandLength([], fixed), []);
  });
});
