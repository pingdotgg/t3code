import {
  type CommandCodeSettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "@t3tools/provider-core/server/textGenerationUtils";
import { investigationUnsupported } from "@t3tools/provider-core/server/textGenerationOperations";
import { collectCommandCode } from "../provider/commandCodeProcess.ts";

export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runCommandCodeJson = Effect.fn("CommandCodeTextGeneration.runCommandCodeJson")(function* <
    S extends Schema.Top,
  >(input: {
    operation: string;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const result = yield* collectCommandCode({
      binaryPath: settings.binaryPath,
      args: [
        "--print",
        "--output-format",
        "text",
        "--plan",
        "--no-session",
        "--no-skills",
        "--no-auto-update",
        "--skip-onboarding",
        "--max-turns",
        "1",
        ...(input.modelSelection.model === "default"
          ? []
          : ["--model", input.modelSelection.model]),
      ],
      cwd: input.cwd,
      environment,
      prompt: input.prompt,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.scoped,
      Effect.timeout("180 seconds"),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Command Code text generation failed.",
            cause,
          }),
      ),
    );
    if (result.code !== 0)
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: result.stderr.trim() || `Command Code exited with code ${result.code}.`,
      });
    // oxlint-disable-next-line t3code/no-inline-schema-compile -- Each operation supplies its output schema.
    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
      extractJsonObject(result.stdout),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Command Code returned invalid structured output.",
            cause,
          }),
      ),
    );
  });
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CommandCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CommandCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CommandCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CommandCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  // Text generation runs Command Code for a single planning turn, which cannot investigate a checkout.
  const generateReviewGuide: TextGeneration.TextGeneration["Service"]["generateReviewGuide"] = () =>
    Effect.fail(investigationUnsupported("generateReviewGuide", "Command Code"));

  const generateTranscriptionPostProcessing: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"] =
    () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateTranscriptionPostProcessing",
          detail: "Command Code does not clean up transcriptions.",
        }),
      );

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
    generateTranscriptionPostProcessing,
  } satisfies TextGeneration.TextGeneration["Service"];
});
