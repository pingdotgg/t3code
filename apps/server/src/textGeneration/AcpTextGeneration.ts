import type { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  AcpSessionRuntime,
  AcpSessionRuntimeStartResult,
} from "../provider/acp/AcpSessionRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
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

export type AcpTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

type Runtime = AcpSessionRuntime["Service"];

export interface AcpTextGenerationConfig {
  readonly providerLabel: string;
  readonly requestLabel: string;
  readonly makeRuntime: (input: {
    readonly cwd: string;
    readonly operation: AcpTextGenerationOperation;
  }) => Effect.Effect<Runtime, TextGenerationError, Scope.Scope>;
  readonly prepareRuntime: (input: {
    readonly operation: AcpTextGenerationOperation;
    readonly runtime: Runtime;
    readonly started: AcpSessionRuntimeStartResult;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<void, TextGenerationError>;
  readonly buildPromptParts?: (input: {
    readonly operation: AcpTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  }) => Effect.Effect<ReadonlyArray<EffectAcpSchema.ContentBlock>, TextGenerationError>;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export function makeAcpTextGeneration(
  config: AcpTextGenerationConfig,
): TextGeneration.TextGeneration["Service"] {
  const runJson = <S extends Schema.Top>(input: {
    readonly operation: AcpTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* config.makeRuntime({
        cwd: input.cwd,
        operation: input.operation,
      });
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(outputRef, (current) => current + text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* config.prepareRuntime({
          operation: input.operation,
          runtime,
          started,
          modelSelection: input.modelSelection,
        });
        const promptParts = config.buildPromptParts
          ? yield* config.buildPromptParts({
              operation: input.operation,
              cwd: input.cwd,
              prompt: input.prompt,
              attachments: input.attachments,
            })
          : ([
              { type: "text", text: input.prompt },
            ] satisfies ReadonlyArray<EffectAcpSchema.ContentBlock>);
        return yield* runtime.prompt({ prompt: [...promptParts] });
      }).pipe(
        Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: `${config.providerLabel} request timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: `${config.requestLabel} request failed.`,
                cause,
              }),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? `${config.requestLabel} request was cancelled.`
              : `${config.providerLabel} returned empty output.`,
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: `${config.providerLabel} returned invalid structured output.`,
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: `${config.requestLabel} text generation failed.`,
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
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

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  };
}
