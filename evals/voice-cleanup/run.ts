import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CodexSettings,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../../apps/server/src/textGeneration/TranscriptionPostProcessing.ts";
import { cases } from "./cases.ts";
import { makeOpenCodeTextGeneration } from "./opencode.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    provider: { type: "string", default: "codex" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { out, model, provider } = values;
const samples = Number(values.samples);
const fixtures = cases.filter((fixture) => !values.case || fixture.id === values.case);
if (
  !out ||
  !model ||
  !fixtures.length ||
  !Number.isSafeInteger(samples) ||
  samples < 1 ||
  (provider !== "codex" && provider !== "opencode")
) {
  throw new Error(
    "Use --out <directory> --model <configured model> [--provider codex|opencode] [--case <id>] [--samples <count>].",
  );
}
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sample: Schema.Number,
      text: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.String),
      passed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
    }),
  ),
);
const decodeSettings = Schema.decodeEffect(CodexSettings);
const decodeResults = Schema.decodeEffect(Results);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-eval-" });
    const service = yield* provider === "opencode"
      ? makeOpenCodeTextGeneration(cwd)
      : makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const key = [];
    for (const fixture of fixtures) {
      const start = fixture.before.length;
      const prompt = buildTranscriptionPostProcessingPrompt(
        "instructions" in fixture ? fixture.instructions : DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
        fixture.transcript,
        {
          text: fixture.before + fixture.selection + fixture.after,
          selection: { start, end: start + fixture.selection.length },
        },
        fixture.cue,
      );
      for (let sample = 1; sample <= samples; sample++) {
        const previous = baseline.find((row) => row.id === fixture.id && row.sample === sample);
        if (values.baseline && !previous)
          throw new Error(`Missing baseline for ${fixture.id} sample ${sample}.`);
        const previousOutput = previous && {
          text: previous.text,
          error: previous.error,
          passed: previous.passed,
        };
        const generated = yield* service
          .generateTranscriptionPostProcessing({
            cwd,
            prompt,
            modelSelection: { instanceId: ProviderInstanceId.make(provider), model },
          })
          .pipe(Effect.result);
        const output = Result.isSuccess(generated)
          ? { text: generated.success.transcription, passed: true }
          : { error: generated.failure.message, passed: false };
        results.push({ id: fixture.id, sample, ...output });
        yield* Effect.log(
          `${fixture.id} sample ${sample}: ${output.passed ? "decoded" : "failed"}`,
        );
        const first = !previous || (yield* Random.nextBoolean);
        review.push({
          ...fixture,
          sample,
          A: first ? output : previousOutput,
          B: first ? previousOutput : output,
        });
        key.push({ id: fixture.id, sample, candidate: first ? "A" : "B" });
      }
    }
    yield* Effect.log(
      `${results.filter((row) => row.passed).length}/${results.length} replies decoded; grade meaning in review.json.`,
    );
    yield* fs.makeDirectory(out, { recursive: true });
    for (const [name, rows] of [
      ["results", results],
      ["review", review],
      ["answer-key", key],
    ] as const) {
      yield* fs.writeFileString(path.join(out, name + ".json"), yield* encodeRows(rows));
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-eval-state-" }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
        ),
      ),
    ),
    Effect.scoped,
  ),
);
