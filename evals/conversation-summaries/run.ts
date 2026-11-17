#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { summaryToolText } from "@t3tools/provider-core/server/conversationEvidence";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { condensedCases, leafCases, type LeafMessage } from "./cases.ts";
import { gradeCondensed, gradeLeaf } from "./grade.ts";
import { morphRunner } from "../shared/morph.ts";

/**
 * How a peer reply reaches the model. `main` sends it as a nameless assistant message, as main
 * does. `peer-as-user` renders it as a historical user message with the speaker in its header, as
 * handoff history does. `full` is this checkout.
 */
const arms = ["main", "peer-as-user", "full"] as const;

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    arm: { type: "string", default: "full" },
    "evidence-module": { type: "string" },
  },
});
if (!values.model || !values.out) throw new Error("Use --model <model> --out <directory>.");
const model = values.model;
const outputDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1)
  throw new Error("--samples must be a positive integer.");
const evidenceText: typeof summaryToolText = values["evidence-module"]
  ? (await import(NodeURL.pathToFileURL(values["evidence-module"]).href)).summaryToolText
  : summaryToolText;
const arm = arms.find((candidate) => candidate === values.arm);
if (arm === undefined) throw new Error(`Unknown --arm ${values.arm}. Use ${arms.join(", ")}.`);
const morph = model.startsWith("morph-");
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
const encodeRunMetadata = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const asArm = (message: LeafMessage, index: number) => {
  const ref = `M${index + 1}`;
  if (message.role === "tool") {
    const text = evidenceText(message.item);
    if (text === null) throw new Error(`Fixture tool ${ref} has no summary evidence.`);
    return { ref, role: "tool" as const, text };
  }
  if (message.role !== "peer" || arm === "full") return { ref, ...message };
  if (arm === "main") return { ref, role: "assistant" as const, text: message.text };
  const [, rendered] = historyResponseItems(
    [
      {
        role: "user",
        text: message.text,
        speaker: message.speaker,
        threadId: ThreadId.make("thread"),
        runId: RunId.make("run"),
        itemId: TurnItemId.make(`item-${ref}`),
        providerThreadId: null,
        status: "completed",
        kind: "peer_reply",
      },
    ],
    "",
  );
  return { ref, role: "user" as const, text: rendered!.content[0]!.text };
};

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "run.json"),
      yield* encodeRunMetadata({
        model,
        arm,
        samples,
        evidenceModule: values["evidence-module"] ?? "checkout",
      }),
    );
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.tap(decodeResults))
      : undefined;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-summary-eval-" });
    const generation = morph
      ? TextGenerationOperations.fromRunner("Morph", morphRunner())
      : yield* CodexTextGeneration.makeCodexTextGeneration(decodeSettings({}));
    const modelSelection = {
      instanceId: ProviderInstanceId.make(morph ? "morph" : "codex"),
      model,
    };
    const results: Array<(typeof Results.Type)[number]> = [];
    const record = (
      id: string,
      sample: number,
      statements: (typeof Results.Type)[number]["statements"],
      failures: ReadonlyArray<string>,
    ) => {
      results.push({ id, sample, statements, failures, passed: failures.length === 0 });
      return encodeResults(results).pipe(
        Effect.flatMap((json) =>
          fs.writeFileString(path.join(outputDirectory, "results.json"), json),
        ),
      );
    };
    for (const fixture of selectedCondensed) {
      for (let sample = 0; sample < samples; sample++) {
        const { statements } = yield* generation.generateConversationSummary({
          cwd,
          modelSelection,
          messages: fixture.summaries.map((text, index) => ({
            ref: `M${index + 1}`,
            role: "summary" as const,
            text,
          })),
        });
        yield* record(fixture.id, sample, statements, gradeCondensed(fixture, statements));
      }
    }
    for (const fixture of selectedLeaf) {
      const messages = fixture.messages.map(asArm);
      const sourceFailures = (fixture.sourceMustNot ?? [])
        .filter((pattern) => messages.some((message) => new RegExp(pattern).test(message.text)))
        .map((pattern) => `source contains excluded payload: ${pattern}`);
      for (let sample = 0; sample < samples; sample++) {
        const { statements } = yield* generation.generateConversationSummary({
          cwd,
          modelSelection,
          messages,
        });
        yield* record(fixture.id, sample, statements, [
          ...sourceFailures,
          ...gradeLeaf(fixture, statements),
        ]);
      }
    }
    if (baseline !== undefined)
      yield* fs.writeFileString(path.join(outputDirectory, "baseline.json"), baseline);
    for (const fixture of [...selectedCondensed, ...selectedLeaf]) {
      const rows = results.filter((row) => row.id === fixture.id);
      const passed = rows.filter((row) => row.passed).length;
      // A case fails when half or more of its samples fail.
      yield* Effect.log(
        `${arm} ${fixture.id} (${fixture.kind}): ${passed}/${rows.length} samples passed, ${passed * 2 > rows.length ? "PASS" : "FAIL"}`,
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
