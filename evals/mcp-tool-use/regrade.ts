#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Grades saved samples again with this checkout's cases and graders, so a grader change can be
 * compared on the same samples instead of a fresh run. Usage: `pnpm mcp-tool-use:regrade
 * <results.jsonl>... [--cases <file.ndjson>]`. Prints each changed sample and a per-case table of
 * pass counts, old → new. Rows with an error are skipped, as the summaries skip them.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import { gradeSample, McpToolUseCase, pastedText } from "./run.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { cases: { type: "string", multiple: true } },
});
const caseFiles =
  values.cases ??
  NodeFS.readdirSync(new URL("./cases", import.meta.url))
    .filter((name) => name.endsWith(".ndjson"))
    .map((name) => new URL(`./cases/${name}`, import.meta.url).pathname);
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
const lines = (file: string) =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
const cases = new Map(
  caseFiles.flatMap(lines).map((line) => [decodeCase(line).id, decodeCase(line)]),
);

for (const file of positionals) {
  const counts = new Map<string, { n: number; was: number; now: number }>();
  for (const line of lines(file)) {
    const row = JSON.parse(line);
    const testCase = cases.get(row.id);
    if (testCase === undefined || row.error !== undefined) continue;
    const failed = gradeSample(testCase.expect, row, pastedText(testCase)).filter(
      (check) => !check.pass,
    );
    const pass = failed.length === 0;
    const count = counts.get(row.id) ?? { n: 0, was: 0, now: 0 };
    count.n++;
    if (row.pass) count.was++;
    if (pass) count.now++;
    counts.set(row.id, count);
    if (pass !== row.pass)
      console.log(
        `${row.id}#${count.n} ${row.pass ? "pass" : "FAIL"} → ${pass ? "pass" : "FAIL"}${failed.length > 0 ? `: ${failed.map((check) => check.check.slice(0, 100)).join(" | ")}` : ""}`,
      );
  }
  console.log(`\n${file}\n| case | was | now |\n| --- | --- | --- |`);
  for (const [id, { n, was, now }] of counts)
    console.log(`| ${id} | ${was}/${n} | ${now}/${n}${was === now ? "" : " *"} |`);
}
