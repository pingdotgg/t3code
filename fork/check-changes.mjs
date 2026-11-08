// Tests and typechecks only what the fork's own commits touch, relative to
// the MT Code release they sit on. Failures listed in known-test-failures.txt
// (they also fail on the unmodified release) are ignored; anything else fails.
//
// Usage: node fork/check-changes.mjs <base-tag>
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Use the workspace's own vp (node_modules/.bin), whatever the caller's PATH.
process.env.PATH = `${resolve("node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;

const base = process.argv[2];
if (!base) throw new Error("usage: check-changes.mjs <base-tag>");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  return r.status ?? 1;
}

const diff = spawnSync("git", ["diff", "--name-only", `${base}..HEAD`], { encoding: "utf8" });
if (diff.status !== 0) throw new Error(`git diff failed: ${diff.error ?? diff.stderr}`);
const changed = diff.stdout
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && existsSync(s));

const tests = changed.filter((f) => /\.test\.tsx?$/.test(f) && !f.includes("/browser/"));
if (tests.length) {
  const report = join(tmpdir(), "fork-test-report.json");
  rmSync(report, { force: true });
  const code = run("vp", [
    "test",
    "run",
    ...tests,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${report}`,
  ]);
  if (code !== 0) {
    if (!existsSync(report)) throw new Error(`tests failed (${code}) and wrote no report`);
    const known = readFileSync(new URL("./known-test-failures.txt", import.meta.url), "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
    const failed = JSON.parse(readFileSync(report, "utf8"))
      .testResults.flatMap((t) => t.assertionResults)
      .filter((a) => a.status === "failed")
      .map((a) => a.fullName);
    const unknown = failed.filter((name) => !known.some((k) => name.includes(k)));
    if (failed.length === 0 || unknown.length) {
      throw new Error(
        `tests failed:\n  ${(unknown.length ? unknown : ["(suite error, see log)"]).join("\n  ")}`,
      );
    }
    console.log(`${failed.length} known failure(s) ignored`);
  }
}

// Typecheck every workspace package with a changed source file, except the
// server: its effect-tsgo run exits non-zero while listing only warnings and
// suggestions, so it can't tell a real error apart. Its tests still run.
const SKIP_TYPECHECK = new Set(["t3"]);
const packages = new Set();
for (const f of changed) {
  const m = /^(apps|packages)\/[^/]+\//.exec(f);
  if (!m) continue;
  const pkgJson = join(m[0], "package.json");
  if (!existsSync(pkgJson)) continue;
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  if (
    pkg.scripts?.typecheck &&
    pkg.name &&
    !pkg.name.includes("mobile") &&
    !SKIP_TYPECHECK.has(pkg.name)
  )
    packages.add(pkg.name);
}
for (const name of packages) {
  if (run("vp", ["run", "--filter", name, "typecheck"]) !== 0)
    throw new Error(`typecheck failed for ${name}`);
}
console.log(`checked ${tests.length} test file(s) and ${packages.size} package(s)`);
