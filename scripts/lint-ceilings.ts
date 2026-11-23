#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot maintenance script; synchronous Node APIs keep it small.
// Rewrites lint-ceilings.json, the per-file debt ceilings of the design-system lint rules, from a
// lint run. It only lowers or removes entries: a file over its ceiling, or a file with no entry,
// has to be fixed. Then it compares the table with the last pushed one (the parents of the
// commits no remote has), so a hand edit cannot raise a ceiling or add a file either.
//
//   vp run lint:ceilings           lower the table to the current counts, then compare
//   vp run lint:ceilings --check   only compare
//   vp run lint:ceilings --check --base <ref>   compare with the table at <ref> instead
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { vitePlusCommand } from "./check-changed-command.ts";

type Entry = number | ReadonlyArray<string>;
type Table = Record<string, Record<string, Entry>>;

const FILE = "lint-ceilings.json";
const COUNT = /file has (\d+)/u;
const NEW_VARIANT = /^New components\/ui variant "([^"]+)"/u;
const GONE_VARIANTS = /no longer exist: (.+?)\. Run /u;

const root = NodePath.resolve(import.meta.dirname, "..");
const sortedTable = (table: Table): Table =>
  Object.fromEntries(
    Object.keys(table)
      .sort()
      .map((rule) => [
        rule,
        Object.fromEntries(
          Object.keys(table[rule]!)
            .sort()
            .map((file) => {
              const entry = table[rule]![file]!;
              return [file, typeof entry === "number" ? entry : [...entry].sort()];
            }),
        ),
      ]),
  );
const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const git = (...args: Array<string>) => run("git", args);
const vp = (...args: Array<string>) => run(...vitePlusCommand(args));

const current: Table = JSON.parse(NodeFS.readFileSync(NodePath.join(root, FILE), "utf8"));
const problems: Array<string> = [];

if (!process.argv.includes("--check")) {
  const lint = vp("lint", "--format", "json", "apps/web/src");
  const output: {
    diagnostics?: Array<{ code?: string; filename: string; message: string }>;
  } = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{")) || "{}");
  if (output.diagnostics === undefined) {
    console.error(`vp lint produced no JSON report:\n${lint.stdout}${lint.stderr}`);
    process.exit(1);
  }
  // Each rule reports one "file has N" summary per file whose count differs from its entry,
  // and lists variants it does not know or no longer finds.
  const counts = new Map<string, number>();
  const newVariants = new Map<string, Array<string>>();
  const goneVariants = new Map<string, Array<string>>();
  for (const { code, filename, message } of output.diagnostics) {
    const rule = /^t3code\((.+)\)$/u.exec(code ?? "")?.[1];
    if (rule === undefined) continue;
    const key = `t3code/${rule}\0${filename}`;
    const count = COUNT.exec(message)?.[1];
    if (count !== undefined) counts.set(key, Number(count));
    const added = NEW_VARIANT.exec(message)?.[1];
    if (added !== undefined) newVariants.set(key, [...(newVariants.get(key) ?? []), added]);
    const gone = GONE_VARIANTS.exec(message)?.[1];
    if (gone !== undefined) goneVariants.set(key, gone.split(", "));
  }

  const seededRules = new Set<string>();
  const ruleOf = (key: string) => key.slice(0, key.indexOf("\0"));
  for (const key of [...counts.keys(), ...newVariants.keys()]) {
    if (current[ruleOf(key)] === undefined) seededRules.add(ruleOf(key));
  }
  for (const rule of seededRules) current[rule] = {};

  let lowered = 0;
  let removed = 0;
  let total = 0;
  for (const entries of Object.values(current)) {
    for (const file of Object.keys(entries)) {
      if (!NodeFS.existsSync(NodePath.join(root, file))) {
        delete entries[file];
        removed++;
      }
    }
  }
  for (const [key, count] of counts) {
    const rule = ruleOf(key);
    const file = key.slice(rule.length + 1);
    const ceiling = current[rule]![file];
    if (seededRules.has(rule)) {
      if (count > 0) current[rule]![file] = count;
    } else if (typeof ceiling !== "number" || count > ceiling) {
      problems.push(
        `${file}: ${rule} has ${count}, ceiling ${typeof ceiling === "number" ? ceiling : 0}. Fix the new occurrences; ceilings never go up.`,
      );
    } else {
      total += ceiling - count;
      if (count === 0) {
        delete current[rule]![file];
        removed++;
      } else {
        current[rule]![file] = count;
        lowered++;
      }
    }
  }
  for (const [key, names] of newVariants) {
    const rule = ruleOf(key);
    const file = key.slice(rule.length + 1);
    if (seededRules.has(rule)) {
      current[rule]![file] = [...((current[rule]![file] as ReadonlyArray<string>) ?? []), ...names];
    } else {
      problems.push(
        `${file}: new components/ui variants ${names.join(", ")}. A feature's look stays in the feature's component.`,
      );
    }
  }
  for (const [key, names] of goneVariants) {
    const rule = ruleOf(key);
    const file = key.slice(rule.length + 1);
    const remaining = ((current[rule]?.[file] as ReadonlyArray<string>) ?? []).filter(
      (name) => !names.includes(name),
    );
    if (remaining.length > 0) current[rule]![file] = remaining;
    else delete current[rule]![file];
    total += names.length;
  }

  NodeFS.writeFileSync(
    NodePath.join(root, FILE),
    `${JSON.stringify(sortedTable(current), null, 2)}\n`,
  );
  vp("fmt", FILE);
  const seeded = seededRules.size > 0 ? `; seeded ${[...seededRules].join(", ")}` : "";
  console.log(
    `${FILE}: lowered ${lowered} entries and removed ${removed}, ${total} occurrences in total${seeded}.`,
  );
}

// The table at the parents of the commits no remote has: what was last pushed. A merge of main
// adds main's tip as a parent, which has no table, so main's files cannot gain entries.
const baseFlag = process.argv.indexOf("--base");
const unpushed = git("rev-list", "--boundary", "HEAD", "--not", "--remotes").stdout.split("\n");
const bases =
  baseFlag >= 0
    ? [process.argv[baseFlag + 1] ?? "HEAD"]
    : unpushed.filter(Boolean).length === 0
      ? ["HEAD"]
      : unpushed.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
const pushed: Table = {};
for (const base of bases) {
  const shown = git("show", `${base}:${FILE}`);
  if (shown.status !== 0) continue;
  for (const [rule, entries] of Object.entries(JSON.parse(shown.stdout) as Table)) {
    pushed[rule] ??= {};
    for (const [file, entry] of Object.entries(entries)) {
      const previous = pushed[rule][file];
      pushed[rule][file] =
        typeof entry === "number"
          ? Math.max(entry, typeof previous === "number" ? previous : 0)
          : [...new Set([...((previous as ReadonlyArray<string>) ?? []), ...entry])];
    }
  }
}
const pushedRules = Object.keys(pushed);
for (const [rule, entries] of Object.entries(current)) {
  // A rule the pushed table lacks is being introduced: its entries are its seed.
  if (pushed[rule] === undefined) continue;
  for (const [file, entry] of Object.entries(entries)) {
    const before = pushed[rule][file];
    if (typeof entry === "number") {
      if (typeof before !== "number") problems.push(`${file}: ${rule} gained an entry.`);
      else if (entry > before)
        problems.push(`${file}: ${rule} ceiling went up from ${before} to ${entry}.`);
    } else {
      const added = entry.filter(
        (name) => !((before as ReadonlyArray<string>) ?? []).includes(name),
      );
      if (added.length > 0) problems.push(`${file}: ${rule} gained ${added.join(", ")}.`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(
    "\nCeilings only go down and a new file starts at 0: fix the occurrences lint reports instead of raising a ceiling. See docs/internals/web-ui.md#lint-ceilings.",
  );
  process.exitCode = 1;
} else if (pushedRules.length === 0) {
  console.log(`${FILE}: no pushed table to compare with (bases ${bases.join(", ")}).`);
} else {
  console.log(`${FILE}: no ceiling is above the pushed table.`);
}
