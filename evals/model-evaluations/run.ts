#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - command-line eval arguments, files, and input digests.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BlindModelEvaluationPacket, ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import {
  buildModelEvaluationPrompt,
  MODEL_EVALUATION_RUBRIC_VERSION,
} from "@t3tools/provider-core/server/modelEvaluation";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { modelEvaluationCases } from "./cases.ts";
import { gradeModelEvaluation } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    baseline: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <Claude model>] [--dry-run].");
const outDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20)
  throw new Error("--samples must be an integer from 1 to 20.");
const requested = new Set(
  values.case?.flatMap((value) => value.split(",")) ??
    modelEvaluationCases.map((entry) => entry.id),
);
const selected = modelEvaluationCases.filter((entry) => requested.has(entry.id));
const unknown = [...requested].filter((id) => !selected.some((entry) => entry.id === id));
if (unknown.length || selected.length === 0)
  throw new Error(`Unknown or empty --case selection: ${unknown.join(", ")}`);

const decodeBaseline = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        case: Schema.String,
        model: Schema.String,
        fixtureHash: Schema.String,
        graderHash: Schema.String,
        pass: Schema.Boolean,
      }),
    ),
  ),
);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const writeJson = (name: string, value: unknown) =>
  NodeFS.writeFileSync(NodePath.join(outDirectory, name), JSON.stringify(value, null, 2) + "\n");
const decodePacket = Schema.decodeUnknownSync(BlindModelEvaluationPacket);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const graderHash = hash(NodeFS.readFileSync(new URL("./grade.ts", import.meta.url), "utf8"));
const baseline = values.baseline
  ? decodeBaseline(NodeFS.readFileSync(values.baseline, "utf8"))
  : [];
const prepared = selected.map((fixture) => {
  const packet = decodePacket(fixture.packet);
  const { prompt } = buildModelEvaluationPrompt(packet);
  const fixtureHash = hash(JSON.stringify({ kind: fixture.kind, packet }));
  const previous = baseline.filter((row) => row.case === fixture.id);
  if (
    values.baseline &&
    (previous.length === 0 ||
      previous.some(
        (row) =>
          row.model !== values.model ||
          row.fixtureHash !== fixtureHash ||
          row.graderHash !== graderHash,
      ))
  )
    throw new Error(`Baseline for ${fixture.id} must use the same model, fixture, and grader.`);
  return { fixture, packet, prompt, promptHash: hash(prompt), fixtureHash, previous };
});

NodeFS.mkdirSync(outDirectory, { recursive: true });
writeJson(
  "prompts.json",
  prepared.map(({ fixture, prompt, promptHash }) => ({ id: fixture.id, prompt, promptHash })),
);
if (values["dry-run"]) {
  process.stdout.write(
    `Validated ${prepared.length} cases and wrote prompts.json only. No scored results or model calls. Cost: $0.\n`,
  );
} else {
  const { makeClaudeTextGeneration } =
    await import("../../apps/server/src/textGeneration/ClaudeTextGeneration.ts");
  await Effect.runPromise(
    Effect.gen(function* () {
      const generation = yield* makeClaudeTextGeneration(decodeClaudeSettings({}));
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: values.model,
      };
      const rows = [];
      for (const item of prepared) {
        for (let sample = 0; sample < samples; sample++) {
          const result = yield* generation
            .generateModelEvaluation({ cwd: process.cwd(), packet: item.packet, modelSelection })
            .pipe(
              Effect.timed,
              Effect.match({
                onSuccess: ([duration, verdict]) => ({
                  ...gradeModelEvaluation(item.fixture, verdict),
                  verdict,
                  error: null,
                  latencyMs: Duration.toMillis(duration),
                }),
                onFailure: (error) => ({
                  pass: false,
                  failures: ["Evaluation call failed."],
                  verdict: null,
                  error: String(error).slice(0, 2_000),
                  latencyMs: null,
                }),
              }),
            );
          rows.push({
            case: item.fixture.id,
            source: item.fixture.source,
            model: values.model,
            sample,
            rubricVersion: MODEL_EVALUATION_RUBRIC_VERSION,
            fixtureHash: item.fixtureHash,
            graderHash,
            promptHash: item.promptHash,
            ...result,
          });
          writeJson("results.json", rows);
        }
      }
      const report = [
        "# Blind model evaluation",
        "",
        `Model: ${values.model}. Rubric: ${MODEL_EVALUATION_RUBRIC_VERSION}. Each case passes only when a strict majority of its samples pass.`,
        "",
        "| Case | Passing samples | Result | Baseline samples |",
        "| --- | --- | --- | --- |",
      ];
      let failed = false;
      for (const item of prepared) {
        const own = rows.filter((row) => row.case === item.fixture.id);
        const passed = own.filter((row) => row.pass).length;
        const pass = passed > own.length / 2;
        failed ||= !pass;
        const previous = item.previous.length
          ? `${item.previous.filter((row) => row.pass).length}/${item.previous.length}`
          : "—";
        report.push(
          `| ${item.fixture.id} | ${passed}/${own.length} | ${pass ? "Pass" : "Fail"} | ${previous} |`,
        );
      }
      report.push(
        "",
        `Provider calls: ${rows.length}. Token usage and dollar cost are not exposed by this CLI operation; consult the configured provider's usage records.`,
        "",
        "Review the raw verdicts before interpreting these guards as general judge quality.",
        "",
      );
      const summary = report.join("\n");
      NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), summary);
      process.stdout.write(summary);
      if (failed) process.exitCode = 1;
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
