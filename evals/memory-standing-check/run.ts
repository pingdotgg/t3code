#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId, type ProjectFactVerdict } from "@t3tools/contracts";
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
    // Capture before the check: every proposed fact was saved for recall.
    "no-check": { type: "boolean", default: false },
  },
});
if (!values.out || (!values.model && !values["no-check"]))
  throw new Error("Use --model <model> --out <directory>, or --no-check --out <directory>.");
const model = values["no-check"] ? "no-check" : values.model!;
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
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-standing-eval-" });
    const morph = model.startsWith("morph-");
    const generation = values["no-check"]
      ? null
      : morph
        ? TextGenerationOperations.fromRunner("Morph", morphRunner())
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
          const verdict: ProjectFactVerdict =
            generation === null
              ? "standing"
              : (yield* generation.checkFactStanding({
                  cwd,
                  modelSelection,
                  statements: [fixture.statement],
                })).verdicts[0]!;
          const outcome = verdict === "standing" ? "kept" : "set_aside";
          return { id: fixture.id, sample, model, verdict, passed: outcome === fixture.expected };
        }),
      { concurrency },
    );
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeResults(results));
    for (const fixture of selected) {
      const passed = results.filter((row) => row.id === fixture.id && row.passed).length;
      const verdicts = results.filter((row) => row.id === fixture.id).map((row) => row.verdict);
      yield* Effect.log(
        `${fixture.id} (${fixture.expected}): ${passed}/${samples} ${passed * 2 > samples ? "PASS" : "FAIL"} [${verdicts.join(", ")}]`,
      );
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-standing-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
