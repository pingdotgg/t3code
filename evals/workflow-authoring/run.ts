#!/usr/bin/env node
// An eval script, not server code: it reads and writes files directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { proxyConfig } from "../shared/proxy.ts";
import { cases } from "./cases.ts";
import { type Case, grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    skill: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    reasoning: { type: "string", default: "low" },
    baseline: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--skill <file>].");
const outDirectory = values.out;
const models = values.model ?? ["gpt-6.1-terra", "gpt-6-luna"];
const skillFile =
  values.skill ?? NodePath.resolve(import.meta.dirname, "../../skills/t3-workflows/SKILL.md");
// An agent is given the skill's body; the front matter only decides when it loads.
const skill = NodeFS.readFileSync(skillFile, "utf8")
  .replace(/^---\n[\s\S]*?\n---\n/, "")
  .trim();
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
const proxy = proxyConfig();

const Row = Schema.Struct({
  model: Schema.String,
  case: Schema.String,
  sample: Schema.Number,
  problems: Schema.Array(Schema.String),
  tokens: Schema.Number,
});
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Row));
const decodeRow = Schema.decodeUnknownSync(Schema.fromJsonString(Row));
const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
    }),
  ),
);

const instructions = [
  "You write workflow definitions files for T3 Code. This is everything you know about them:",
  "",
  "<skill>",
  skill,
  "</skill>",
  "",
  "Reply with the complete definitions file in one ```ts code block and nothing else.",
].join("\n");

const sample = Effect.fn("evaluateWorkflowAuthoring.sample")(function* (
  entry: Case,
  model: string,
  index: number,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/responses`).pipe(
    HttpClientRequest.setHeaders(proxy.headers),
    HttpClientRequest.bodyJson({
      model,
      instructions,
      input: [{ role: "user", content: entry.task }],
      reasoning: { effort: values.reasoning },
      store: false,
    }),
    Effect.flatMap(client.execute),
  );
  const body = yield* response.text;
  if (response.status !== 200) {
    return yield* Effect.die(new Error(`Model API ${response.status}: ${body}`));
  }
  const decoded = decodeResponse(body);
  const reply = decoded.output
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content as Array<{ text?: string }>).map((part) => part.text ?? ""))
    .join("");
  const code = /```(?:ts|typescript)?\n([\s\S]*?)```/.exec(reply)?.[1] ?? reply;
  const file = NodePath.join(outDirectory, `${entry.id}.${model}.${index}.ts`);
  NodeFS.writeFileSync(file, code);
  const problems = yield* Effect.promise(() => grade(file, entry));
  return {
    model,
    case: entry.id,
    sample: index,
    problems,
    tokens: decoded.usage?.total_tokens ?? 0,
  };
});

/** Half or more of a case's samples failing is the case failing. */
const passes = (rows: ReadonlyArray<typeof Row.Type>, model: string, id: string) => {
  const own = rows.filter((row) => row.model === model && row.case === id);
  return own.length > 0 && own.filter((row) => row.problems.length > 0).length < own.length / 2;
};

NodeFS.mkdirSync(outDirectory, { recursive: true });
const summary = await Effect.runPromise(
  Effect.gen(function* () {
    const count = Number(values.samples);
    const rows = yield* Effect.forEach(
      models.flatMap((model) =>
        selected.flatMap((entry) =>
          Array.from({ length: count }, (_, index) => ({ model, entry, index })),
        ),
      ),
      ({ model, entry, index }) =>
        sample(entry, model, index).pipe(
          Effect.catchDefect((defect) =>
            Effect.succeed({
              model,
              case: entry.id,
              sample: index,
              problems: [`The sample did not run: ${String(defect)}`],
              tokens: 0,
            }),
          ),
        ),
      // The grader starts an engine per scenario; a few at a time keeps their timings honest.
      { concurrency: 3 },
    );
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.ndjson"),
      rows.map((row) => encodeRow(row)).join("\n") + "\n",
    );
    const baseline = values.baseline
      ? NodeFS.readFileSync(values.baseline, "utf8")
          .trim()
          .split("\n")
          .map((line) => decodeRow(line))
      : undefined;
    const words = skill.split(/\s+/).length;
    const lines = [`skill ${skillFile}, ${words} words, ${count} samples per case`, ""];
    lines.push("| model | case | samples passed | verdict | baseline |", "|---|---|---|---|---|");
    for (const model of models) {
      for (const entry of selected) {
        const own = rows.filter((row) => row.model === model && row.case === entry.id);
        const good = own.filter((row) => row.problems.length === 0).length;
        const before =
          baseline === undefined ? "" : passes(baseline, model, entry.id) ? "pass" : "fail";
        lines.push(
          `| ${model} | ${entry.id} | ${good}/${own.length} | ${passes(rows, model, entry.id) ? "pass" : "FAIL"} | ${before} |`,
        );
      }
    }
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    lines.push("", `${tokens} tokens`, "", "## Problems", "");
    for (const row of rows) {
      for (const problem of row.problems) {
        lines.push(`- ${row.model} ${row.case} #${row.sample}: ${problem}`);
      }
    }
    const report = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
    return report;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(summary);
