// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs locally what CI runs for this branch's changes: format and lint of the
// changed files, knip, typecheck of the affected packages and their dependents,
// and the test files beside the changed files.
//
//   vp run check:changed          compare against the merge base with origin/main
//   vp run check:changed <ref>    compare against <ref>
//
// Uncommitted and untracked files count. The package mapping comes from
// .github/scripts/ci-changes.cjs, so this typechecks what CI would typecheck.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const CODE = /\.[cm]?[jt]sx?$/;

const git = (...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const base = process.argv[2] ?? git("merge-base", "HEAD", "origin/main")[0] ?? "origin/main";
// --no-renames lists a rename as its old and new path, as CI does.
const untracked = git("ls-files", "--others", "--exclude-standard");
const files = [
  ...new Set([...git("diff", "--name-only", "--no-renames", base, "--"), ...untracked]),
].sort();

if (files.length === 0) {
  console.log(`check:changed: no changes since ${base.slice(0, 12)}.`);
  process.exit(0);
}

const present = files.filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
const code = present.filter((file) => CODE.test(file));
const packages = readWorkspace();
const { affected, outputs } = decide(files, packages, false);

// Changed test files, and the test files beside a changed source file
// (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
// `related` reaches most of a package: one leaf server file pulled in 252 of
// 406 server test files and took 7 minutes. CI runs the rest.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const tests = new Set(code.filter((file) => TEST.test(file)));
for (const file of code) {
  const dir = NodePath.dirname(file);
  const prefix = `${NodePath.basename(file).replace(CODE, "")}.`;
  for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
    if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.join(dir, entry));
  }
}

// knip:check takes about 35 s and cannot be scoped to a package, so it runs
// only when the change can leave a file, export, or dependency unused.
const addedOrDeleted = new Set([
  ...git("diff", "--name-only", "--no-renames", "--diff-filter=AD", base, "--"),
  ...untracked,
]);
const changedExport =
  code.length > 0 &&
  git("diff", "--unified=0", base, "--", ...code).some((line) =>
    /^[+-](?!\+\+ |-- ).*\bexport\b/.test(line),
  );
const runKnip =
  changedExport ||
  files.some(
    (file) =>
      (CODE.test(file) && addedOrDeleted.has(file)) ||
      NodePath.basename(file) === "package.json" ||
      file === "knip.jsonc",
  );

const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
const steps = [
  present.length > 0 && {
    name: "format",
    args: ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present],
  },
  code.length > 0 && { name: "lint", args: ["lint", ...code] },
  runKnip && { name: "knip", args: ["run", "knip:check"] },
  affected.length > 0 && {
    name: `typecheck (${affected.length} packages)`,
    args: ["run", "--cache", "--concurrency-limit", "4", ...filters(affected), "typecheck"],
  },
  // From the repo root, the root vite.config.ts hands each file to its package's config.
  tests.size > 0 && {
    name: `test (${tests.size} files)`,
    args: ["test", "run", "--passWithNoTests", ...tests],
  },
].filter((step) => step !== false);

console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)}`);
const results = steps.map((step) => {
  console.log(`\n> vp ${step.name}`);
  const started = performance.now();
  const { status } = NodeChildProcess.spawnSync("vp", step.args, { cwd: root, stdio: "inherit" });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  return { name: step.name, ok: status === 0, seconds };
});

console.log("\ncheck:changed summary");
for (const result of results) {
  console.log(`  ${result.ok ? "pass" : "FAIL"}  ${result.name}  ${result.seconds}s`);
}
const ciOnly = (["build", "rust", "mobile_native", "release_smoke"] as const).filter(
  (job) => outputs[job],
);
if (ciOnly.length > 0) console.log(`  CI also runs: ${ciOnly.join(", ")}`);
if (!runKnip) console.log("  knip skipped: no files, exports, or dependencies changed");
if (results.some((result) => !result.ok)) process.exit(1);
