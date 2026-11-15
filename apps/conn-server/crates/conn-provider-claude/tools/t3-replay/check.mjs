#!/usr/bin/env node
// The T3 replay as a check for tools/check.sh: runs run.sh and compares each scenario's result
// with `expected-failures.txt`. Exit 0 when exactly the listed scenarios fail; exit 1 when a
// scenario that passed fails now, when a listed one passes now (remove it from the list), or
// when the replay did not report every scenario in scenarios.json.
//
//   node check.mjs

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const listFile = NodePath.join(here, "expected-failures.txt");

const expected = new Map();
for (const raw of NodeFS.readFileSync(listFile, "utf8").split("\n")) {
  const row = raw.trim();
  if (!row || row.startsWith("#")) continue;
  const [name, ...reason] = row.split(/\s+/);
  expected.set(name, reason.join(" "));
}
const scenarios = Object.keys(
  JSON.parse(NodeFS.readFileSync(NodePath.join(here, "scenarios.json"), "utf8")).scenarios,
);

const run = NodeChildProcess.spawnSync(NodePath.join(here, "run.sh"), [], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");

const results = new Map();
for (const row of (run.stdout ?? "").split("\n")) {
  const m = /^(PASS|FAIL) (\S+)/.exec(row);
  if (m) results.set(m[2], m[1]);
}

const problems = [];
for (const name of scenarios) {
  const result = results.get(name);
  if (result === undefined) problems.push(`${name}: no result (the replay did not run it; see the output above)`);
  else if (result === "FAIL" && !expected.has(name)) problems.push(`${name}: FAILS now and is not in expected-failures.txt`);
  else if (result === "PASS" && expected.has(name)) problems.push(`${name}: PASSES now; remove it from expected-failures.txt`);
}
for (const name of expected.keys()) {
  if (!scenarios.includes(name)) problems.push(`${name}: listed in expected-failures.txt but not in scenarios.json`);
}

const passed = [...results.values()].filter((r) => r === "PASS").length;
console.log(
  `\nt3-replay: ${passed} of ${scenarios.length} pass; ${expected.size} expected to fail (${listFile})`,
);
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log("t3-replay: as expected");
