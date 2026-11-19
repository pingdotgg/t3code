#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { morphRunner } from "../shared/morph.ts";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const decodeSettings = Schema.decodeUnknownSync(CodexSettings);
const encodeResults = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "1" },
    "no-curation": { type: "boolean", default: false },
  },
});
if (!values.out || (!values.model && !values["no-curation"]))
  throw new Error("Use --model <model> --out <directory>, or --no-curation --out <directory>.");
const model = values["no-curation"] ? "no-curation" : values.model!;
const out = values.out;
const samples = Number(values.samples);
const concurrency = Number(values.concurrency);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("Invalid sample count.");
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency.");
const selected = cases.filter(
  (fixture) => !values.case || values.case.split(",").includes(fixture.id),
);
if (!selected.length) throw new Error("No matching cases.");

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-curation-eval-" });
    const morph = model.startsWith("morph-");
    const generation = values["no-curation"]
      ? null
      : morph
        ? TextGenerationOperations.fromRunner("Morph", morphRunner(), {
            supportsInvestigation: false,
            supportsBlindEvaluation: true,
          })
        : yield* CodexTextGeneration.makeCodexTextGeneration(decodeSettings({}));
    const modelSelection = {
      instanceId: ProviderInstanceId.make(morph ? "morph" : "codex"),
      model,
    };
    yield* fs.makeDirectory(out, { recursive: true });
    if (values.baseline)
      yield* fs.writeFileString(
        path.join(out, "baseline.json"),
        yield* fs.readFileString(values.baseline),
      );
    const runs = selected.flatMap((fixture) =>
      Array.from({ length: samples }, (_, sample) => ({ fixture, sample })),
    );
    const results = yield* Effect.forEach(
      runs,
      ({ fixture, sample }) =>
        Effect.gen(function* () {
          const result =
            generation === null
              ? { decisions: [] }
              : yield* generation.curateProjectMemory({
                  cwd,
                  modelSelection,
                  facts: fixture.facts,
                });
          return {
            id: fixture.id,
            sample,
            model,
            result,
            passed: grade(fixture, result),
            error: null as string | null,
          };
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              id: fixture.id,
              sample,
              model,
              result: { decisions: [] },
              passed: false,
              error: error._tag === "TextGenerationError" ? error.detail : "Generation failed.",
            }),
          ),
        ),
      { concurrency },
    );
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeResults(results));
    for (const fixture of selected) {
      const passed = results.filter((row) => row.id === fixture.id && row.passed).length;
      const errors = results.filter((row) => row.id === fixture.id && row.error !== null).length;
      yield* Effect.log(
        `${fixture.id}: ${passed}/${samples} ${passed * 2 > samples ? "PASS" : "FAIL"} (${errors} generation errors)`,
      );
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-curation-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
