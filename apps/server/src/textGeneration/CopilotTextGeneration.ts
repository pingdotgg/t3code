/**
 * CopilotTextGeneration — Git text generation via the `@github/copilot-sdk`.
 *
 * One-shot JSON generation (commit messages, PR content, branch names, thread
 * titles): spin up an SDK session, `sendAndWait` the prompt, and decode the
 * assistant's final message as JSON.
 *
 * @module CopilotTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type CopilotSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { type ThreadTitleGenerationResult, type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { makeCopilotSdkClient } from "../provider/sdk/CopilotSdkClient.ts";
import { resolveCopilotSdkTunables } from "../provider/sdk/CopilotSdkModels.ts";
import type { SessionConfig } from "@github/copilot-sdk";

const COPILOT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  // No construction-time effect is needed; the SDK client is created lazily per
  // request inside `runCopilotJson`.
  yield* Effect.void;

  const runCopilotJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const client = yield* makeCopilotSdkClient({
        binaryPath: copilotSettings.binaryPath,
        environment,
      });

      // Forward the caller's selected reasoning-effort / context-tier options
      // (parity with the interactive adapter and the sibling text generators).
      const tunables = resolveCopilotSdkTunables(modelSelection.options);
      const sessionConfig = {
        workingDirectory: cwd,
        // One-shot JSON generation must never execute tools: the prompt embeds
        // untrusted content (staged diffs, PR bodies), so auto-approving would
        // let prompt injection run shell/file tools in `cwd` unattended. Deny
        // every request — the model just produces its text answer without them.
        onPermissionRequest: async () => ({ kind: "reject" as const }),
        ...(modelSelection.model ? { model: modelSelection.model } : {}),
        ...(tunables.reasoningEffort ? { reasoningEffort: tunables.reasoningEffort } : {}),
        ...(tunables.contextTier ? { contextTier: tunables.contextTier } : {}),
      } as unknown as SessionConfig;

      const session = yield* client.createSession(sessionConfig);

      const rawResult = yield* Effect.tryPromise({
        try: () =>
          session
            .sendAndWait({ prompt, agentMode: "interactive" }, COPILOT_TIMEOUT_MS)
            .then((message) => (message?.data.content ?? "").trim()),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "GitHub Copilot request failed.",
            cause,
          }),
      }).pipe(Effect.ensuring(Effect.promise(() => session.disconnect().catch(() => {}))));

      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: "GitHub Copilot returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "GitHub Copilot returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Copilot text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      policy: input.policy,
    });
    const generated = yield* runCopilotJson({
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

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      policy: input.policy,
      changeRequestTemplate: input.changeRequestTemplate,
    });
    const generated = yield* runCopilotJson({
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

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CopilotTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      previousTitle: input.previousTitle,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
