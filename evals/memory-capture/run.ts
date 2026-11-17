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
  },
});
if (!values.model || !values.out) throw new Error("Use --model <model> --out <directory>.");
const model = values.model;
const out = values.out;
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("Invalid sample count.");
const selected = cases.filter(
  (fixture) => !values.case || values.case.split(",").includes(fixture.id),
);
if (!selected.length) throw new Error("No matching cases.");

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-eval-" });
    const morph = model.startsWith("morph-");
    const generation = morph
      ? TextGenerationOperations.fromRunner("Morph", morphRunner())
      : yield* CodexTextGeneration.makeCodexTextGeneration(decodeSettings({}));
    const modelSelection = {
      instanceId: ProviderInstanceId.make(morph ? "morph" : "codex"),
      model,
    };
    const results = [];
    yield* fs.makeDirectory(out, { recursive: true });
    if (values.baseline)
      yield* fs.writeFileString(
        path.join(out, "baseline.json"),
        yield* fs.readFileString(values.baseline),
      );
    for (const fixture of selected) {
      let passed = 0;
      for (let sample = 0; sample < samples; sample++) {
        const result = yield* generation.generateKnowledgeCandidates({
          cwd,
          modelSelection,
          ...fixture.input,
        });
        const failures = grade(fixture, result);
        if (!failures.length) passed++;
        results.push({
          id: fixture.id,
          sample,
          model,
          ...result,
          failures,
          passed: !failures.length,
        });
        yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeResults(results));
      }
      yield* Effect.log(
        `${fixture.id}: ${passed}/${samples} ${passed * 2 > samples ? "PASS" : "FAIL"}`,
      );
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
