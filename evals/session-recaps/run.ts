#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSessionRecap, ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeClaudeTextGeneration } from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { cases } from "./cases.ts";

const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeResults = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      rows: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          sample: Schema.Number,
          messages: Schema.String,
          rubric: Schema.String,
          output: AgentSessionRecap,
        }),
      ),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    baseline: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const out = values.out;
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error("Use 1–10 samples.");
const fixtures = cases.filter((fixture) => !values.case || fixture.id === values.case);
if (fixtures.length === 0) throw new Error("Unknown case.");

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : null;
    if (baseline && baseline.model !== values.model) {
      throw new Error("Baseline must use the same model.");
    }
    if (baseline) {
      for (const fixture of fixtures) {
        for (let sample = 0; sample < samples; sample++) {
          const previous = baseline.rows.filter(
            (row) => row.id === fixture.id && row.sample === sample,
          );
          if (
            previous.length !== 1 ||
            previous[0]?.messages !== fixture.messages ||
            previous[0]?.rubric !== fixture.rubric
          ) {
            throw new Error(
              `Baseline must contain one matching excerpt and rubric for ${fixture.id} sample ${sample}.`,
            );
          }
        }
      }
    }
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recap-eval-" });
    const generation = yield* makeClaudeTextGeneration(yield* decodeSettings({}));
    if (!generation.generateSessionRecap) throw new Error("Recap operation is unavailable.");
    const rows = [];
    const review = [];
    const answerKey = [];
    for (const fixture of fixtures) {
      for (let sample = 0; sample < samples; sample++) {
        const output = yield* generation.generateSessionRecap({
          cwd,
          recentMessages: fixture.messages,
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: values.model,
          },
        });
        const previous = baseline?.rows.find(
          (row) => row.id === fixture.id && row.sample === sample,
        );
        const newFirst = !previous || NodeCrypto.randomInt(2) === 0;
        review.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          messages: fixture.messages,
          rubric: fixture.rubric,
          A: newFirst ? output : previous?.output,
          ...(previous ? { B: newFirst ? previous.output : output } : {}),
          grades: previous ? { A: "", B: "" } : { A: "" },
          preferred: "",
        });
        answerKey.push({ id: fixture.id, sample, candidate: newFirst ? "A" : "B" });
        rows.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          messages: fixture.messages,
          rubric: fixture.rubric,
          output,
        });
      }
    }
    const summary = {
      model: values.model,
      cases: fixtures.length,
      samples: rows.length,
      baseline: baseline !== null,
      reports: { results: "results.json", review: "review.json", answerKey: "answer-key.json" },
      cost: {
        usd: null,
        status: "unavailable",
        reason:
          "The production Claude text generator does not expose token usage or billing cost; normal model usage applies.",
      },
      grading:
        "Score each labeled output against its rubric in review.json before opening answer-key.json or results.json. Record pass/fail in grades and optionally a preferred label. A case passes when more than half its samples pass. No quality score is computed before human grading.",
    };
    yield* fs.makeDirectory(out, { recursive: true });
    for (const [name, report] of [
      ["results", { model: values.model, rows }],
      ["review", review],
      ["answer-key", answerKey],
      ["summary", summary],
    ] as const) {
      yield* fs.writeFileString(path.join(out, `${name}.json`), yield* encodeJson(report));
    }
    yield* Effect.log(
      `Wrote ${rows.length} samples to ${out}. Score review.json before opening answer-key.json or results.json. Run metadata and cost availability are in summary.json.`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
