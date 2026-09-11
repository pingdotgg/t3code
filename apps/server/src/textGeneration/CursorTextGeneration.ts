import * as NodeOS from "node:os";
import * as FileSystem from "effect/FileSystem";

import { Agent, type AgentOptions, type RunResult } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type CursorSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
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
import { cursorSdkModelSelection } from "../provider/cursorSdkModel.ts";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);
type CursorTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function emptyCursorSdkResultDetail(result: RunResult): string {
  switch (result.status) {
    case "cancelled":
      return "Cursor SDK request was cancelled.";
    case "error":
      return "Cursor SDK request finished with an error and no output.";
    case "finished":
      return "Cursor SDK returned empty output.";
  }
}

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const resolvedEnvironment = environment ?? process.env;

  const resolveCursorApiKey = (operation: CursorTextGenerationOperation) =>
    Effect.gen(function* () {
      if (!cursorSettings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor is disabled in T3 Code settings.",
        });
      }

      const apiKey = resolvedEnvironment.CURSOR_API_KEY?.trim();
      if (!apiKey) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
        });
      }

      return apiKey;
    });

  const runCursorJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: CursorTextGenerationOperation;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const apiKey = yield* resolveCursorApiKey(operation);
      // The SDK loads sandbox.json independently of settingSources and lets it
      // expand the writable paths. Its public API cannot override that policy.
      if (yield* fs.exists(`${NodeOS.homedir()}/.cursor/sandbox.json`)) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Cursor text generation cannot enforce workspace isolation with a custom ~/.cursor/sandbox.json. Use another text-generation provider.",
        });
      }
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-text-" });
      const agentOptions = {
        apiKey,
        mode: "plan",
        model: cursorSdkModelSelection(modelSelection),
        local: {
          cwd,
          autoReview: false,
          sandboxOptions: { enabled: true },
          settingSources: [],
          enableAgentRetries: true,
        },
      } satisfies AgentOptions;

      const request = Effect.gen(function* () {
        const agent = yield* Effect.acquireRelease(
          Effect.tryPromise((signal) =>
            Agent.create(agentOptions).then((agent) => {
              if (signal.aborted) agent.close();
              return agent;
            }),
          ),
          (agent) =>
            Effect.tryPromise(() => agent[Symbol.asyncDispose]()).pipe(
              Effect.timeout("5 seconds"),
              Effect.ignore({ log: true }),
            ),
          { interruptible: true },
        );
        const run = yield* Effect.tryPromise((signal) =>
          agent.send(prompt).then((run) => {
            if (signal.aborted) void run.cancel().catch(() => undefined);
            return run;
          }),
        );
        yield* Effect.addFinalizer(() =>
          run.status === "running"
            ? Effect.tryPromise(() => run.cancel()).pipe(
                Effect.timeout("5 seconds"),
                Effect.ignore({ log: true }),
              )
            : Effect.void,
        );
        return yield* Effect.tryPromise(() => run.wait());
      }).pipe(Effect.scoped);
      const promptResult = yield* request.pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor SDK request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const rawResult = promptResult.result?.trim() ?? "";
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: emptyCursorSdkResultDetail(promptResult),
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor SDK returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Cursor SDK text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CursorTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCursorJson({
        operation: "generateCommitMessage",
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
    Effect.fn("CursorTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCursorJson({
        operation: "generatePrContent",
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
    Effect.fn("CursorTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCursorJson({
        operation: "generateBranchName",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CursorTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runCursorJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
