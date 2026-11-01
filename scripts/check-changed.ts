// @effect-diagnostics nodeBuiltinImport:off - hashes inputs with node:crypto and sizes the budget with node:os.
// Runs CI's fast checks for this branch's changes: format and lint of the
// changed files, knip, generated GraphQL operations, typecheck of the affected
// packages and their dependents, the test files beside the changed files, and
// the cross-file checks those miss (agent context budget, React Compiler
// coverage of the changed client files).
// A dependency change also gets the unused-patch install check below. CI still
// runs the full test suites and the jobs listed in the summary.
//
//   vp run check:changed                  compare against the closest merge base with any remote main
//   vp run check:changed <ref>            compare against the merge base with <ref>
//   vp run check:changed --concurrency 1  run the steps one at a time
//
// Uncommitted and untracked files count. Affected packages come from
// .github/scripts/ci-changes.cjs, the same mapping CI uses to gate its jobs.
// The steps run side by side within a budget derived from the machine's cores
// and available memory, and each prints its output when it finishes. A step
// running past the timeout is killed with its process group and reported as
// TIMEOUT. A rerun on exactly the files of the last passing run prints that
// run's summary.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

// A typecheck or test step can take several cores and gigabytes of memory, so
// allow one step per two cores and per 6 GiB of available memory.
export const defaultConcurrency = (cores: number, availableBytes: number) =>
  Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(availableBytes / (6 * GiB))));

export type Outcome = "pass" | "FAIL" | "TIMEOUT";

export interface Step<R> {
  readonly name: string;
  readonly run: Effect.Effect<{ readonly ok: boolean; readonly output: string }, never, R>;
  // Budget slots the step holds: one per worker it runs in parallel.
  readonly weight?: number;
  // Vitest runs started together race to rebuild node_modules/.vitest-cache (ENOTEMPTY).
  readonly serial?: boolean;
}

// Interrupting a step at its timeout closes the scopes of the processes it
// spawned, which kills each one's process group.
export const runSteps = Effect.fn("checkChanged.runSteps")(function* <R>(
  steps: ReadonlyArray<Step<R>>,
  options: { readonly concurrency: number; readonly timeoutSeconds: number },
) {
  const budget = yield* Semaphore.make(options.concurrency);
  // Steps claim budget one at a time, in order: Semaphore lets a light request
  // take free slots ahead of a waiting heavier one, which would delay typecheck.
  const admission = yield* Semaphore.make(1);
  const serial = yield* Semaphore.make(1);
  return yield* Effect.forEach(
    steps,
    (step) => {
      const timed = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* Effect.timeoutOption(step.run, `${options.timeoutSeconds} seconds`);
        const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
        const outcome: Outcome = Option.match(result, {
          onNone: () => "TIMEOUT",
          onSome: ({ ok }) => (ok ? "pass" : "FAIL"),
        });
        const time =
          outcome === "TIMEOUT"
            ? `killed after ${options.timeoutSeconds}s`
            : `${seconds.toFixed(1)}s`;
        yield* Console.log(`\n> vp ${step.name}  ${outcome}  ${time}`);
        const output = Option.getOrUndefined(result)?.output.trimEnd();
        if (output) yield* Console.log(output);
        return { name: step.name, outcome, time };
      });
      const slots = Math.min(step.weight ?? 1, options.concurrency);
      const limited = Effect.acquireUseRelease(
        admission.withPermit(budget.take(slots)),
        () => timed,
        () => budget.release(slots),
      );
      return step.serial ? serial.withPermit(limited) : limited;
    },
    { concurrency: "unbounded" },
  );
});

const CacheEntry = Schema.fromJsonString(
  Schema.Struct({ key: Schema.String, summary: Schema.Array(Schema.String) }),
);
const decodeCacheEntry = Schema.decodeEffect(CacheEntry);
const encodeCacheEntry = Schema.encodeEffect(CacheEntry);
const decodeRootPackageJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ "knip:check": Schema.String }) })),
);

const collectBytes = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

// Fails on a nonzero exit: an empty file list from a broken index would
// otherwise pass as "no changes". quotePath=false keeps non-ASCII paths as real
// paths instead of quoted escapes.
export const git = Effect.fn("checkChanged.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], { cwd }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectBytes(handle.stdout), collectBytes(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          `check:changed: git ${args.join(" ")} exited with ${exitCode}: ${stderr.toString().trim()}`,
        );
      }
      return stdout;
    }),
  );
});
export const gitLines = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((stdout) => stdout.toString().split("\n").filter(Boolean)));

export const comparisonBase = Effect.fn("checkChanged.comparisonBase")(function* (
  root: string,
  explicitRef: Option.Option<string>,
) {
  const candidates = Option.isSome(explicitRef)
    ? [{ ref: explicitRef.value, rev: explicitRef.value }]
    : (yield* gitLines(root, ["remote"])).map((name) => ({
        ref: name + "/main",
        rev: "refs/remotes/" + name + "/main",
      }));
  let closest: { ref: string; base: string; ahead: number } | undefined;
  for (const { ref, rev } of candidates) {
    const base = yield* git(root, ["merge-base", "HEAD", rev]).pipe(
      Effect.map((stdout) => stdout.toString().trim()),
      Effect.orElseSucceed(() => undefined),
    );
    if (!base) continue;
    const ahead = Number((yield* git(root, ["rev-list", "--count", base + "..HEAD"])).toString());
    if (!closest || ahead < closest.ahead) closest = { ref, base, ahead };
  }
  if (!closest) {
    const tried = candidates.map(({ ref }) => ref).join(", ") || "a remote main";
    return yield* Effect.fail(
      "check:changed: no merge base with " + tried + ". Run git fetch or pass a ref.",
    );
  }
  return closest;
});

const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A flag wins over its environment variable; either must be a positive integer.
const override = Effect.fn("checkChanged.override")(function* (
  flagName: string,
  flag: Option.Option<number>,
  envName: string,
) {
  const [name, value] = Option.isSome(flag)
    ? [`--${flagName}`, flag]
    : [envName, yield* Config.option(Config.Int(envName))];
  if (Option.isSome(value) && value.value < 1) {
    return yield* Effect.fail(`check:changed: ${name} must be a positive integer.`);
  }
  return value;
});

// Tests that read a doc; a changed doc has no test beside it to select them.
export const docReaderTests = (files: ReadonlyArray<string>) =>
  files.includes("docs/user/t3-connect-troubleshooting.md")
    ? ["apps/server/src/cloud/ConnectReachability.test.ts"]
    : [];

const checkChanged = Effect.fn("checkChanged")(function* (input: {
  readonly ref: Option.Option<string>;
  readonly concurrency: Option.Option<number>;
  readonly timeout: Option.Option<number>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const inRoot = (file: string) => path.join(root, file);

  // macOS counts its file cache as used, so available memory there would
  // starve a large Mac. Elsewhere availableMemory() honors a cgroup limit.
  const platform = yield* HostProcess.Platform;
  const concurrency = Option.getOrElse(
    yield* override("concurrency", input.concurrency, "CHECK_CHANGED_CONCURRENCY"),
    () =>
      defaultConcurrency(
        NodeOS.availableParallelism(),
        platform === "darwin" ? NodeOS.totalmem() : process.availableMemory(),
      ),
  );
  const timeoutSeconds = Option.getOrElse(
    yield* override("timeout", input.timeout, "CHECK_CHANGED_TIMEOUT"),
    () => 900,
  );

  const lines = (...args: Array<string>) => gitLines(root, args);

  const { ref, base } = yield* comparisonBase(root, input.ref);
  // --no-renames lists a rename as its old and new path, as CI does.
  const changedFiles = lines("diff", "--name-only", "--no-renames", base, "--");
  const untrackedFiles = lines("ls-files", "--others", "--exclude-standard");
  const files = [...new Set([...(yield* changedFiles), ...(yield* untrackedFiles)])].sort();

  if (files.length === 0) {
    yield* Console.log(`check:changed: no changes since ${base.slice(0, 12)} (${ref}).`);
    return true;
  }
  yield* Console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)} (${ref})`);

  // Ignored generated sources, declarations, env files, and install state affect check results.
  // Include them in the key, but skip large ignored folders that no check reads.
  // Recompute after a passing run so edits made during it are never cached as passing.
  const ci = Option.getOrElse(yield* Config.option(Config.String("CI")), () => "");
  const inputKey = Effect.gen(function* () {
    const hash = NodeCrypto.createHash("sha256");
    // CI changes test behavior (vite.config.ts rejects .only under CI).
    hash.update(`${process.version}\0${base}\0${ci}\0`);
    hash.update(
      yield* git(root, [
        "diff",
        "--binary",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        base,
        "--",
      ]),
    );
    const ignored = yield* lines(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ":(glob)**/.generated/**",
      ":(glob)**/.astro/**",
      ":(glob)**/*.d.ts",
      ":(glob)**/.env*",
      ":(exclude,glob)**/node_modules/**",
    );
    for (const file of [
      // Raw bytes of changed files too: .gitattributes normalizes line endings in
      // the diff, but the formatter reads the file as it is on disk.
      ...(yield* changedFiles),
      ...(yield* untrackedFiles),
      ...ignored,
      "node_modules/.modules.yaml",
      "node_modules/.pnpm/lock.yaml",
    ]) {
      hash.update(`\0${file}\0`);
      // Untracked nested repositories are listed as directories.
      const info = yield* Effect.option(fs.stat(inRoot(file)));
      if (Option.isSome(info) && info.value.type === "File") {
        hash.update(yield* fs.readFile(inRoot(file)));
      }
    }
    return hash.digest("hex");
  });
  const key = yield* inputKey;
  const cachePath = inRoot("node_modules/.cache/check-changed.json");
  // A missing or unreadable cache is a miss, never a failure.
  const cached = yield* fs
    .readFileString(cachePath)
    .pipe(Effect.flatMap(decodeCacheEntry), Effect.option);
  if (Option.isSome(cached) && cached.value.key === key) {
    yield* Console.log("Nothing changed since the last passing run.\n");
    for (const line of cached.value.summary) yield* Console.log(line);
    return true;
  }

  const present = yield* Effect.filter(files, (file) => fs.exists(inRoot(file)));
  const code = present.filter((file) => CODE.test(file));
  const packages = readWorkspace();
  const { affected, outputs } = decide(files, packages, false);

  // Changed test files, and the test files beside a changed source file
  // (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
  // `related` reaches most of a package: one leaf server file pulled in 252 of
  // 406 server test files and took 7 minutes. CI runs the rest.
  const tests = new Set(code.filter((file) => TEST.test(file)));
  for (const file of code) {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file).replace(CODE, "")}.`;
    for (const entry of yield* fs.readDirectory(inRoot(dir))) {
      if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(path.join(dir, entry));
    }
  }
  for (const test of docReaderTests(files)) tests.add(test);
  // It reads files other than the ones beside it, so no changed file selects it.
  if (affected.includes("t3")) tests.add("apps/server/src/provider/AgentContextBudget.test.ts");

  // React Compiler coverage compiles every client source file, so run only the
  // changed files' cases, in one extra step: a -t filter in the main test step
  // would drop every other test. An app is skipped when the main step already
  // runs its coverage file unfiltered. File filters mirror each coverage test.
  const compilerApps = [
    {
      test: "apps/web/src/reactCompilerCoverage.test.ts",
      root: "apps/web/src/",
      // Test names keep the repo-relative path.
      name: (file: string) => file,
      compiled: (file: string) =>
        /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file) && !file.endsWith(".gen.ts"),
      // Web has only per-file cases.
      always: [],
    },
    {
      test: "apps/mobile/src/reactCompilerCoverage.test.ts",
      root: "apps/mobile/src/",
      name: (file: string) => file.slice("apps/mobile/".length),
      compiled: (file: string) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file),
      // The Metro, cache, and stale-allowlist cases check more than one file, deletions included.
      always: ["^(?!.*compiles )"],
    },
  ].flatMap(({ test, root: appRoot, name, compiled, always }) => {
    const changed = files.filter((file) => file.startsWith(appRoot) && compiled(file));
    if (changed.length === 0 || tests.has(test)) return [];
    const names = changed
      .filter((file) => present.includes(file))
      .map((file) => `compiles ${escapeRegExp(name(file))}$`);
    const pattern = [...names, ...always];
    return pattern.length > 0 ? [{ test, names, pattern }] : [];
  });

  // knip:check cannot be scoped to a package. Any code change can leave a file,
  // export, or dependency unused (removing the last import of a helper does), so
  // it runs whenever code or a manifest changes.
  const runKnip = files.some(
    (file) => CODE.test(file) || path.basename(file) === "package.json" || file === "knip.jsonc",
  );
  // CI runs knip:check as one script of `knip ... && knip ...` passes. The passes
  // do not depend on each other, so they run side by side here.
  const rootPackage = yield* fs
    .readFileString(inRoot("package.json"))
    .pipe(Effect.flatMap(decodeRootPackageJson), Effect.orDie);
  const knipCheck = rootPackage.scripts["knip:check"];
  const knipPasses: Array<Array<string>> = [];
  for (const command of knipCheck.split(" && ")) {
    const [bin, ...args] = command.trim().split(/\s+/);
    if (bin !== "knip" || /["'$\\|;&<>]/.test(command)) {
      return yield* Effect.fail(`check:changed cannot split knip:check: ${command}`);
    }
    knipPasses.push(["exec", "knip", ...args]);
  }

  // A version bump can leave a patch unused, causing pnpm to reject the install
  // with ERR_PNPM_UNUSED_PATCH. Check it here as Release Smoke does in CI.
  const runPatchCheck = files.some(
    (file) =>
      file === "pnpm-workspace.yaml" ||
      file === "pnpm-lock.yaml" ||
      file === ".pnpmfile.cjs" ||
      file.startsWith("patches/") ||
      file.startsWith("apps/mobile/deps/") ||
      path.basename(file) === "package.json",
  );

  // Output is piped, so keep the colors a terminal would get.
  const env = process.stdout.isTTY ? { FORCE_COLOR: "1" } : {};
  const vp = (args: ReadonlyArray<string>, cwd = root) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("vp", args, { cwd, env, extendEnv: true, forceKillAfter: "5 seconds" }),
        );
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
          { concurrency: 2 },
        );
        return { ok: exitCode === 0, output };
      }),
    ).pipe(Effect.catch((error) => Effect.succeed({ ok: false, output: error.message })));

  // Resolve without the lockfile in a temp copy to preserve the working tree and lockfile.
  // Copy mobile modules too: they are file: dependencies, not workspace packages.
  // Cached registry metadata limits this to patches stranded by local changes, not registry drift.
  const checkPatches = Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-patch-check-" });
      const copy = Effect.fnUntraced(function* (relative: string) {
        const dest = path.join(temp, relative);
        yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
        yield* fs.copy(inRoot(relative), dest);
      });
      yield* copy("package.json");
      yield* copy("pnpm-workspace.yaml");
      for (const pkg of packages) yield* copy(`${pkg.dir}/package.json`);
      const modulesDir = "apps/mobile/modules";
      if (yield* fs.exists(inRoot(modulesDir))) {
        for (const entry of yield* fs.readDirectory(inRoot(modulesDir))) {
          const manifest = `${modulesDir}/${entry}/package.json`;
          if (yield* fs.exists(inRoot(manifest))) yield* copy(manifest);
        }
      }
      for (const extra of ["apps/mobile/deps", "patches", ".pnpmfile.cjs"]) {
        if (yield* fs.exists(inRoot(extra))) yield* copy(extra);
      }
      const result = yield* vp(["install", "--lockfile-only", "--ignore-scripts"], temp);
      if (result.ok || !result.output.includes("ERR_PNPM_UNUSED_PATCH")) return result;
      return {
        ok: false,
        output:
          `${result.output}\nUnused dependency patches: remove each patch named above from ` +
          "patchedDependencies in pnpm-workspace.yaml and from patches/, " +
          "update it to the version the install resolves, " +
          "or pin the dependency that pulls it in to the patched version.",
      };
    }),
  ).pipe(Effect.catch((error) => Effect.succeed({ ok: false, output: error.message })));

  // CI's Lint job checks that generated GraphQL operations match their sources.
  const graphql = ["apps/server", "packages/source-control-github"].filter((dir) =>
    files.some((file) => file.startsWith(`${dir}/`)),
  );
  const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
  const typecheckWorkers = Math.min(concurrency, affected.length);
  const command = (name: string, args: ReadonlyArray<string>) => ({ name, run: vp(args) });
  const compilerFiles = compilerApps.reduce((count, app) => count + app.names.length, 0);

  const steps: Array<Step<never>> = [
    ...(runPatchCheck ? [{ name: "unused patches", run: checkPatches }] : []),
    ...(present.length > 0
      ? [command("format", ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present])]
      : []),
    ...(code.length > 0 ? [command("lint", ["lint", ...code])] : []),
    ...(runKnip
      ? knipPasses.map((args, index) => command(`knip ${index + 1}/${knipPasses.length}`, args))
      : []),
    ...graphql.map((dir) =>
      command(`graphql (${dir})`, ["run", "--filter", `./${dir}`, "generate", "--check"]),
    ),
    ...(affected.length > 0
      ? [
          {
            // `tsc --noEmit` writes nothing another package reads, so dependency order
            // only made dependents wait: --parallel cut a contracts change from 13 s to 9 s.
            ...command(`typecheck (${affected.length} packages)`, [
              "run",
              "--cache",
              "--parallel",
              "--concurrency-limit",
              String(typecheckWorkers),
              ...filters(affected),
              "typecheck",
            ]),
            weight: typecheckWorkers,
          },
        ]
      : []),
    // From the repo root, the root vite.config.ts hands each file to its package's config.
    ...(tests.size > 0
      ? [
          {
            ...command(`test (${tests.size} files)`, [
              "test",
              "run",
              "--passWithNoTests",
              ...tests,
            ]),
            serial: true,
          },
        ]
      : []),
    ...(compilerApps.length > 0
      ? [
          {
            ...command(`react compiler (${compilerFiles} files)`, [
              "test",
              "run",
              ...compilerApps.map((app) => app.test),
              "-t",
              compilerApps.flatMap((app) => app.pattern).join("|"),
            ]),
            serial: true,
          },
        ]
      : []),
  ];

  const results = yield* runSteps(steps, { concurrency, timeoutSeconds });

  const summary = ["check:changed summary"];
  for (const result of results) {
    summary.push(`  ${result.outcome}  ${result.name}  ${result.time}`);
  }
  if (results.some((result) => result.outcome === "TIMEOUT")) {
    summary.push(
      `  TIMEOUT: ran past ${timeoutSeconds}s and was killed; this is not a check failure. ` +
        "Raise --timeout or lower --concurrency.",
    );
  }
  const ciOnly = Object.entries({
    "full test suites": outputs.test || outputs.test_web || outputs.test_server,
    build: outputs.build,
    rust: outputs.rust,
    "mobile native lint": outputs.mobile_native,
    "release smoke": outputs.release_smoke,
  }).flatMap(([job, runs]) => (runs ? [job] : []));
  if (ciOnly.length > 0) summary.push(`  CI also runs: ${ciOnly.join(", ")}`);
  if (!runPatchCheck) summary.push("  unused patch check skipped: no dependency files changed");
  if (!runKnip) summary.push("  knip skipped: no code or manifest changed");
  yield* Console.log(`\n${summary.join("\n")}`);

  if (results.some((result) => result.outcome !== "pass")) return false;
  if ((yield* inputKey) !== key) {
    yield* Console.log("  pass not cached: files changed during the run");
    return true;
  }
  // Write then rename, so a concurrent run never reads half a file.
  const temp = `${cachePath}.${process.pid}`;
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
    yield* fs.writeFileString(temp, yield* encodeCacheEntry({ key, summary }));
    yield* fs.rename(temp, cachePath);
  }).pipe(Effect.catch((error) => Console.warn(`  pass not cached: ${error.message}`)));
  return true;
});

export const checkChangedCommand = Command.make(
  "check-changed",
  {
    ref: Argument.String("ref").pipe(
      Argument.withDescription("Compare against the merge base with this ref."),
      Argument.optional,
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withDescription(
        "Budget of parallel steps and typecheck workers; also CHECK_CHANGED_CONCURRENCY. Defaults to one per two cores and per 6 GiB of available memory.",
      ),
      Flag.optional,
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription(
        "Seconds before a step is killed; also CHECK_CHANGED_TIMEOUT. Defaults to 900.",
      ),
      Flag.optional,
    ),
  },
  (input) =>
    checkChanged(input).pipe(
      Effect.catch((message) => Console.error(message).pipe(Effect.as(false))),
      // exitCode, not a failed exit: runMain calls process.exit() on failure, and
      // piped stdout is asynchronous on macOS, so it would cut off step output.
      Effect.flatMap((ok) =>
        Effect.sync(() => {
          if (!ok) process.exitCode = 1;
        }),
      ),
    ),
).pipe(Command.withDescription("Run CI's fast checks for this branch's changes."));

if (import.meta.main) {
  Command.run(checkChangedCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
