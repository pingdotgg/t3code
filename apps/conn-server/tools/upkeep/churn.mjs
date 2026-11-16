#!/usr/bin/env node
// Upstream churn per followed part: commits and changed lines in the Conn monorepo over a
// window that ends at HEAD. Reads tools/upkeep/followed-files.txt.
//
//   node tools/upkeep/churn.mjs [--days 30] [--by-pathspec]
//
// Counts non-merge commits (`git log --no-merges`), so a change counts once, at its own
// commit, also when it came in through an upstream merge. Test files are left out, as in the
// bump report: paths with `.test.`, `/test/`, `/tests/`, `/__tests__/` or `/testkit/`.
// A commit that touches two parts counts once in each part and once in the total.
// It runs one `git log` per pathspec over the full history: several minutes on a large checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { monorepoRoot as repo } from "../monorepo.mjs";
import { gitEnv } from "../sealed-env.mjs";

const args = process.argv.slice(2);
const daysAt = args.indexOf("--days");
const days = daysAt >= 0 ? Number(args[daysAt + 1]) : 30;
const byPathspec = args.includes("--by-pathspec");

const here = NodePath.dirname(new URL(import.meta.url).pathname);
const pin = "HEAD";

const git = (argv) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...argv], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: gitEnv(),
  });

const pinTime = Number(git(["show", "-s", "--format=%ct", pin]).trim());
const since = new Date((pinTime - days * 86400) * 1000).toISOString();

const parts = [];
for (const raw of NodeFS.readFileSync(NodePath.join(here, "followed-files.txt"), "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const head = line.match(/^\[(.+)\]$/);
  if (head) parts.push({ name: head[1], specs: [] });
  else parts.at(-1)?.specs.push(line);
}

const isTest = (p) => /\.test\.|\/tests?\/|\/__tests__\/|\/testkit\//.test(p);

/** Commits and changed lines (added + deleted) for a set of pathspecs, tests left out. */
function measure(specs) {
  const out = git(["log", "--no-merges", `--since=${since}`, pin, "--format=@%H", "--numstat", "--", ...specs]);
  const commits = new Set();
  let lines = 0;
  let current;
  let counted = false;
  for (const row of out.split("\n")) {
    if (row.startsWith("@")) {
      current = row.slice(1);
      counted = false;
      continue;
    }
    const cols = row.split("\t");
    if (cols.length < 3 || isTest(cols[2])) continue;
    const added = Number(cols[0]);
    const deleted = Number(cols[1]);
    lines += (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
    if (!counted && current) {
      commits.add(current);
      counted = true;
    }
  }
  return { commits: commits.size, lines };
}

console.log(`Window: ${days} days to HEAD (${since.slice(0, 10)} .. HEAD)`);
console.log("part\tcommits\tlines");
for (const part of parts) {
  const m = measure(part.specs);
  console.log(`${part.name}\t${m.commits}\t${m.lines}`);
  if (byPathspec) {
    for (const spec of part.specs) {
      if (spec.startsWith(":(exclude)")) continue;
      const one = measure([spec, ...part.specs.filter((s) => s.startsWith(":(exclude)"))]);
      console.log(`  ${spec}\t${one.commits}\t${one.lines}`);
    }
  }
}
const all = measure(parts.flatMap((p) => p.specs.filter((s) => !s.startsWith(":(exclude)"))));
console.log(`all followed paths (each commit once)\t${all.commits}\t${all.lines}`);
const server = measure(["apps/server", "packages"]);
console.log(`apps/server + packages (reference)\t${server.commits}\t${server.lines}`);
