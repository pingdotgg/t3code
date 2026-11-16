#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { condensedCases, leafCases } from "./cases.ts";
import { gradeCondensed, gradeLeaf } from "./grade.ts";

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
const outputDirectory = values.out;
const samples = Number(values.samples);
const selectedIds = values.case?.split(",");
const selected = <T extends { readonly id: string }>(fixtures: ReadonlyArray<T>) =>
  fixtures.filter((fixture) => selectedIds === undefined || selectedIds.includes(fixture.id));
const selectedCondensed = selected(condensedCases);
const selectedLeaf = selected(leafCases);
if (selectedCondensed.length + selectedLeaf.length === 0)
  throw new Error(
    `Unknown --case ${values.case}. Available cases: ${[...condensedCases, ...leafCases].map((fixture) => fixture.id).join(", ")}`,
  );
const Results = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    sample: Schema.Number,
    statements: Schema.Array(
      Schema.Struct({ text: Schema.String, citations: Schema.Array(Schema.String) }),
    ),
    failures: Schema.Array(Schema.String),
    passed: Schema.Boolean,
  }),
);
const decodeSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeResults = Schema.decodeEffect(Schema.fromJsonString(Results));
const encodeResults = Schema.encodeEffect(Schema.fromJsonString(Results));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.tap(decodeResults))
      : undefined;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-summary-eval-" });
    const generation = yield* CodexTextGeneration.makeCodexTextGeneration(decodeSettings({}));
    const results: Array<(typeof Results.Type)[number]> = [];
    const record = (
      id: string,
      sample: number,
      statements: (typeof Results.Type)[number]["statements"],
      failures: ReadonlyArray<string>,
    ) => {
      results.push({ id, sample, statements, failures, passed: failures.length === 0 });
    };
    for (const fixture of selectedCondensed) {
      for (let sample = 0; sample < samples; sample++) {
        const { statements } = yield* generation.generateConversationSummary({
          cwd,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
          messages: fixture.summaries.map((text, index) => ({
            ref: `M${index + 1}`,
            role: "summary" as const,
            text,
          })),
        });
        record(fixture.id, sample, statements, gradeCondensed(fixture, statements));
      }
    }
    for (const fixture of selectedLeaf) {
      for (let sample = 0; sample < samples; sample++) {
        const { statements } = yield* generation.generateConversationSummary({
          cwd,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
          messages: fixture.messages.map((message, index) => {
            const ref = `M${index + 1}`;
            return message.role === "peer"
              ? { ref, role: "peer" as const, speaker: message.speaker, text: message.text }
              : { ref, role: message.role, text: message.text };
          }),
        });
        record(fixture.id, sample, statements, gradeLeaf(fixture, statements));
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeResults(results),
    );
    if (baseline !== undefined)
      yield* fs.writeFileString(path.join(outputDirectory, "baseline.json"), baseline);
    for (const fixture of [...selectedCondensed, ...selectedLeaf]) {
      const rows = results.filter((row) => row.id === fixture.id);
      const passed = rows.filter((row) => row.passed).length;
      // A case fails when half or more of its samples fail.
      yield* Effect.log(
        `${fixture.id} (${fixture.kind}): ${passed}/${rows.length} samples passed, ${passed * 2 > rows.length ? "PASS" : "FAIL"}`,
      );
    }
    yield* Effect.log(`Results in ${outputDirectory}`);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-summary-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
