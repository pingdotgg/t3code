#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Grades saved samples again with this checkout's cases and graders: `pnpm mcp-tool-use:regrade
 * <results.jsonl>... [--cases <file>]` prints pass counts per case, old → new. Rows with an error
 * are skipped. A sample that stopped early and passes now is "cut short": its turn never finished.
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
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
    .map((name) => NodeURL.fileURLToPath(new URL(`./cases/${name}`, import.meta.url)));
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
const lines = (file: string) =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
const cases = new Map(
  caseFiles.flatMap(lines).map((line) => [decodeCase(line).id, decodeCase(line)]),
);

for (const file of positionals) {
  const counts = new Map<string, { n: number; was: number; now: number; cut: number }>();
  for (const line of lines(file)) {
    const row = JSON.parse(line);
    const testCase = cases.get(row.id);
    if (testCase === undefined || row.error !== undefined) continue;
    const failed = gradeSample(testCase.expect, row, pastedText(testCase)).filter(
      (check) => !check.pass,
    );
    const cut = failed.length === 0 && row.stopReason === "failed_early";
    const pass = failed.length === 0 && !cut;
    const count = counts.get(row.id) ?? { n: 0, was: 0, now: 0, cut: 0 };
    count.n++;
    if (row.pass) count.was++;
    if (pass) count.now++;
    if (cut) count.cut++;
    counts.set(row.id, count);
    if (pass !== row.pass || cut)
      console.log(
        `${row.id}#${count.n} ${row.pass ? "pass" : "FAIL"} → ${cut ? "cut short" : pass ? "pass" : "FAIL"}${failed.length > 0 ? `: ${failed.map((check) => check.check.slice(0, 100)).join(" | ")}` : ""}`,
      );
  }
  console.log(`\n${file}\n| case | was | now |\n| --- | --- | --- |`);
  for (const [id, { n, was, now, cut }] of counts)
    console.log(
      `| ${id} | ${was}/${n} | ${now}/${n}${cut > 0 ? ` (${cut} cut short)` : ""}${was === now ? "" : " *"} |`,
    );
}
