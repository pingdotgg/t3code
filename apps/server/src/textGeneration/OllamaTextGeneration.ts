import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TextGenerationError, type ModelSelection, type OllamaSettings } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { buildBranchNamePrompt, buildCommitMessagePrompt, buildPrContentPrompt, buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
import { type TextGenerationShape, type CommitMessageGenerationInput, type PrContentGenerationInput, type BranchNameGenerationInput, type ThreadTitleGenerationInput } from "./TextGeneration.ts";
import { sanitizeCommitSubject, sanitizePrTitle, sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { ollamaChat } from "../provider/ollamaRuntime.js";

export const makeOllamaTextGeneration = Effect.fn("makeOllamaTextGeneration")(function* (
  ollamaSettings: OllamaSettings,
  processEnv?: Record<string, string | undefined>,
) {
  const apiKey = processEnv?.OLLAMA_API_KEY;
  const resolveModel = (modelSelection: ModelSelection): string =>
    modelSelection.model?.trim() || "qwen2.5:7b";

  const runOllamaJson = <S extends Schema.Top>(input: {
    readonly operation: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }) =>
    Effect.gen(function* () {
      const model = resolveModel(input.modelSelection);
      const response = yield* ollamaChat({ baseUrl: ollamaSettings.baseUrl, apiKey, model, messages: [{ role: "user", content: input.prompt }] });
      const rawText = response.message.content.trim();
      if (rawText.length === 0) {
        return yield* Effect.fail(new TextGenerationError({ operation: input.operation, detail: "Ollama returned empty output." }));
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawText)).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(new TextGenerationError({ operation: input.operation, detail: "Ollama returned invalid structured output.", cause })),
        ),
      );
    }).pipe(
      Effect.mapError((cause) => new TextGenerationError({ operation: input.operation, detail: cause instanceof Error ? cause.message : String(cause), cause })),
    );

  return {
    generateCommitMessage: (input: CommitMessageGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildCommitMessagePrompt({ branch: input.branch, stagedSummary: input.stagedSummary, stagedPatch: input.stagedPatch, includeBranch: input.includeBranch === true });
        const generated = yield* runOllamaJson({ operation: "generateCommitMessage", cwd: input.cwd, prompt, outputSchemaJson: outputSchema, modelSelection: input.modelSelection });
        return { subject: sanitizeCommitSubject(generated.subject), body: generated.body.trim(), ...("branch" in generated && typeof generated.branch === "string" ? { branch: sanitizeFeatureBranchName(generated.branch) } : {}) };
      }),
    generatePrContent: (input: PrContentGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({ baseBranch: input.baseBranch, headBranch: input.headBranch, commitSummary: input.commitSummary, diffSummary: input.diffSummary, diffPatch: input.diffPatch });
        const generated = yield* runOllamaJson({ operation: "generatePrContent", cwd: input.cwd, prompt, outputSchemaJson: outputSchema, modelSelection: input.modelSelection });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      }),
    generateBranchName: (input: BranchNameGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({ message: input.message, attachments: input.attachments });
        const generated = yield* runOllamaJson({ operation: "generateBranchName", cwd: input.cwd, prompt, outputSchemaJson: outputSchema, modelSelection: input.modelSelection });
        return { branch: sanitizeBranchFragment(generated.branch) };
      }),
    generateThreadTitle: (input: ThreadTitleGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({ message: input.message, attachments: input.attachments });
        const generated = yield* runOllamaJson({ operation: "generateThreadTitle", cwd: input.cwd, prompt, outputSchemaJson: outputSchema, modelSelection: input.modelSelection });
        return { title: sanitizeThreadTitle(generated.title) };
      }),
  } satisfies TextGenerationShape;
});
