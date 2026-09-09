#!/usr/bin/env node
// This CLI uses Node argument parsing and random ordering at the application boundary.
// @effect-diagnostics nodeBuiltinImport:off
// Run with --model <configured-model> --out /tmp/title-eval.
// Pass --baseline /tmp/previous-eval/results.json to compare two generation runs.
// Add --initial to evaluate only the opening request.
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeCodexTextGeneration } from "../src/textGeneration/CodexTextGeneration.ts";
import { threadTitleEvaluationCases } from "../src/textGeneration/ThreadTitleEvaluation.ts";
import {
  formatThreadTitleContext,
  type ThreadTitleMessage,
} from "../src/textGeneration/ThreadTitleContext.ts";
import { resolveThreadTitleLinks } from "../src/textGeneration/ThreadTitleLinks.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as ServerConfig from "../src/config.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    initial: { type: "boolean", default: false },
  },
});
if (!values.model || !values.out)
  throw new Error("Use --model <configured-model> --out <directory>.");
const model = values.model;
const outputDirectory = values.out;
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      latencyMs: Schema.Number,
      linkedContextDigest: Schema.String,
    }),
  ),
);
const decodeResults = Schema.decodeUnknownEffect(Results);
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-title-evaluation-" });
    const generation = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const answerKey = [];
    for (const fixture of threadTitleEvaluationCases) {
      const previous = baseline.find((entry) => entry.id === fixture.id);
      if (values.baseline && !previous) throw new Error(`Baseline is missing ${fixture.id}.`);
      const firstMessage: ThreadTitleMessage | undefined = fixture.messages.find(
        (message) => message.role === "user",
      );
      if (!firstMessage) throw new Error(`Fixture ${fixture.id} has no user message.`);
      const context = formatThreadTitleContext(fixture.messages);
      const message = values.initial ? firstMessage.text : context.message;
      const attachments = values.initial ? firstMessage.attachments : context.attachments;
      const [elapsed, { generated, linkedContextDigest }] = yield* Effect.gen(function* () {
        const linkedContext = yield* resolveThreadTitleLinks({
          cwd,
          message,
        });
        const linkedContextDigest = NodeCrypto.createHash("sha256")
          .update(linkedContext ?? "")
          .digest("hex");
        if (previous && previous.linkedContextDigest !== linkedContextDigest) {
          throw new Error(
            `Linked context changed for ${fixture.id}. Record a new baseline before comparing titles.`,
          );
        }
        const generated = yield* generation.generateThreadTitle({
          cwd,
          message,
          previousTitle: values.initial ? undefined : fixture.previousTitle,
          attachments,
          linkedContext,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
        });
        return { generated, linkedContextDigest };
      }).pipe(Effect.timed);
      const oldTitle = previous?.title ?? fixture.previousTitle;
      const newFirst = NodeCrypto.randomInt(2) === 0;
      results.push({
        id: fixture.id,
        title: generated.title,
        latencyMs: Duration.toMillis(elapsed),
        needsRefinement: generated.needsRefinement ?? false,
        linkedContextDigest,
      });
      review.push({
        id: fixture.id,
        source: fixture.source,
        request: fixture.request,
        rubric: fixture.rubric,
        A: newFirst ? generated.title : oldTitle,
        B: newFirst ? oldTitle : generated.title,
        preferred: "",
        subjectAccuracy: "",
        recognitionAmongNearbyThreads: "",
      });
      answerKey.push({ id: fixture.id, candidate: newFirst ? "A" : "B" });
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    for (const [name, report] of [
      ["results", results],
      ["review", review],
      ["answer-key", answerKey],
    ] as const) {
      yield* fs.writeFileString(
        path.join(outputDirectory, `${name}.json`),
        yield* encodeReport(report),
      );
    }
    yield* Effect.log(
      `Wrote ${results.length} cases to ${outputDirectory}. Score review.json before opening answer-key.json. Latency is in results.json.`,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ProcessRunner.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-title-evaluation-state-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  ),
);
