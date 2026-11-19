#!/usr/bin/env node
// Fails on lint and dependency findings that sit on lines added since the merge base with upstream/main,
// so T3's existing code is never flagged. Usage: check-added-diagnostics.mjs [--lint-only] [--files <path>...]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const STANDARDS_DIR = import.meta.dirname;
const TOOLCHAIN_ROOT = NodePath.dirname(STANDARDS_DIR);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// Oxlint cannot ignore paths above its config directory, so agent tooling directories are skipped here.
const SKIPPED_PREFIXES = [".agents/", ".claude/", ".repos/"];
const DEPENDENCY_ROOTS = ["apps", "packages"];
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

const run = (command, args, cwd) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
};

const git = (args, cwd) => {
  const result = run("git", args, cwd);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
};

const parseArgs = (argv) => {
  const options = { lintOnly: false, files: null };
  for (const arg of argv) {
    if (arg === "--lint-only") options.lintOnly = true;
    else if (arg === "--files") options.files = [];
    else if (options.files) options.files.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.files?.length === 0) throw new Error("--files needs at least one path");
  return options;
};

const toRepoPath = (root, file) =>
  NodePath.relative(root, NodePath.resolve(root, file)).split(NodePath.sep).join("/");

const lines = (output) => output.split("\0").filter(Boolean);

/** Added line ranges per file, as half-open [start, end) pairs from `git diff -U0`. */
const addedRanges = (root, base, files) => {
  const ranges = new Map();
  const untracked = new Set(lines(git(["ls-files", "--others", "--exclude-standard", "-z"], root)));
  for (const file of files) {
    if (untracked.has(file)) {
      const count = NodeFS.readFileSync(NodePath.join(root, file), "utf8").split("\n").length;
      ranges.set(file, [[1, count + 1]]);
    }
  }
  const tracked = files.filter((file) => !ranges.has(file));
  if (tracked.length === 0) return ranges;
  const patch = git(["diff", "-U0", "--no-color", "--no-renames", base, "--", ...tracked], root);
  let current = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : null;
      if (current) ranges.set(current, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.get(current).push([start, start + count]);
  }
  return ranges;
};

// vp only runs inside a workspace, so it runs from the checkout that holds this script and lints absolute paths.
const lintFindings = (root, files, ranges) => {
  const vp = NodePath.join(TOOLCHAIN_ROOT, "apps/board/node_modules/.bin/vp");
  const result = run(
    vp,
    [
      "lint",
      "-c",
      NodePath.join(STANDARDS_DIR, "oxlint.config.ts"),
      "--format=json",
      ...files.map((file) => NodePath.join(root, file)),
    ],
    TOOLCHAIN_ROOT,
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`vp lint failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  const report = JSON.parse(result.stdout);
  return report.diagnostics
    .map((diagnostic) => {
      const span = diagnostic.labels?.[0]?.span;
      return {
        file: toRepoPath(root, NodePath.resolve(TOOLCHAIN_ROOT, diagnostic.filename)),
        line: span?.line ?? 0,
        column: span?.column ?? 0,
        rule: diagnostic.code ?? "oxlint",
        message: diagnostic.message.replace(/\s+/g, " ").trim(),
      };
    })
    .filter((finding) =>
      (ranges.get(finding.file) ?? []).some(
        ([start, end]) => finding.line >= start && finding.line < end,
      ),
    );
};

const importLine = (root, from, specifier) => {
  try {
    const source = NodeFS.readFileSync(NodePath.join(root, from), "utf8").split("\n");
    const index = source.findIndex(
      (line) => line.includes(`"${specifier}"`) || line.includes(`'${specifier}'`),
    );
    return index === -1 ? 1 : index + 1;
  } catch {
    return 1;
  }
};

const dependencyMessage = (violation) => {
  if (violation.type === "cycle") {
    return `circular import: ${violation.cycle.map((step) => step.name).join(" -> ")}`;
  }
  return violation.from === violation.to
    ? "module is neither an entry point nor imported"
    : `${violation.from} -> ${violation.to}`;
};

const dependencyFindings = (root) => {
  const roots = DEPENDENCY_ROOTS.filter((dir) => NodeFS.existsSync(NodePath.join(root, dir)));
  const result = run(
    process.execPath,
    [
      NodePath.join(
        TOOLCHAIN_ROOT,
        "apps/board/node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
      ),
      "--config",
      NodePath.join(STANDARDS_DIR, ".dependency-cruiser.cjs"),
      "--ignore-known",
      NodePath.join(STANDARDS_DIR, "dependency-baseline.json"),
      "--output-type",
      "json",
      ...roots,
    ],
    root,
  );
  if (!result.stdout.startsWith("{")) {
    throw new Error(`dependency-cruiser failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout)
    .summary.violations.filter((violation) => violation.rule.severity === "error")
    .map((violation) => ({
      file: violation.from,
      line: importLine(root, violation.from, violation.unresolvedTo ?? violation.to),
      column: 1,
      rule: violation.rule.name,
      message: dependencyMessage(violation),
    }));
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  let base;
  try {
    base = git(["merge-base", "upstream/main", "HEAD"], root).trim();
  } catch {
    console.error(
      `add the upstream remote: git remote add upstream ${UPSTREAM_URL} && git fetch upstream main`,
    );
    return 2;
  }

  const requested = options.files && options.files.map((file) => toRepoPath(root, file));
  const pathspec = requested ? ["--", ...requested] : [];
  const changed = [
    ...lines(
      git(
        ["diff", "--name-only", "--diff-filter=ACMR", "--no-renames", "-z", base, ...pathspec],
        root,
      ),
    ),
    ...lines(git(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], root)),
  ];
  const files = [...new Set(changed)].filter(
    (file) =>
      SOURCE_FILE.test(file) &&
      !SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
      NodeFS.existsSync(NodePath.join(root, file)),
  );
  if (files.length === 0) {
    console.log("standards: no added source lines to check");
    return 0;
  }

  const findings = lintFindings(root, files, addedRanges(root, base, files));
  const dependencyScope = files.some((file) =>
    DEPENDENCY_ROOTS.some((dir) => file.startsWith(`${dir}/`)),
  );
  if (!options.lintOnly && dependencyScope) findings.push(...dependencyFindings(root));

  for (const { file, line, column, rule, message } of findings) {
    console.log(`${file}:${line}:${column} ${rule}: ${message}`);
  }
  if (findings.length === 0) {
    console.log(`standards: ${files.length} files clean`);
    return 0;
  }
  console.log(`standards: ${findings.length} findings on added lines`);
  return 1;
};

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
