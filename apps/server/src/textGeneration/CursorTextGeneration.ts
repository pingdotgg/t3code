import { Agent, type AgentOptions, type Run, type RunResult, type SDKAgent } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
const CURSOR_METADATA_WORKSPACE_PREFIX = "t3-cursor-metadata-";

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

const ignoreCursorCleanupFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.ignore({ log: true }));

interface CursorSdkRequest {
  readonly result: Promise<RunResult>;
  readonly cancel: () => void;
}

/**
 * Own the SDK objects and their temporary workspace beyond the caller's
 * deadline. Cursor's promises do not accept an AbortSignal, so interruption
 * requests cancellation without awaiting it; this owner removes the workspace
 * only after create/send and any acquired run have settled.
 */
function runCursorSdkRequest(input: {
  readonly agentOptions: AgentOptions;
  readonly prompt: string;
  readonly removeWorkspace: () => Promise<void>;
}): CursorSdkRequest {
  let cancellationRequested = false;
  let run: Run | undefined;
  let runWait: Promise<RunResult> | undefined;
  let cancellation: Promise<void> | undefined;

  const cancelRun = () => {
    if (run === undefined || cancellation !== undefined) return;
    cancellation = (async () => {
      const cancel =
        run.status === "running" && run.supports("cancel") ? run.cancel() : Promise.resolve();
      const wait = runWait ?? (run.supports("wait") ? run.wait() : Promise.resolve(undefined));
      await Promise.allSettled([cancel, wait]);
    })();
  };

  const result = (async () => {
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.create(input.agentOptions);
      if (cancellationRequested) {
        throw new Error("Cursor SDK request was cancelled before sending.");
      }
      run = await agent.send(input.prompt);
      runWait = run.wait();
      if (cancellationRequested) {
        cancelRun();
        await cancellation;
      }
      return await runWait;
    } finally {
      if (cancellationRequested) {
        cancelRun();
        await cancellation?.catch(() => undefined);
      }
      if (agent !== undefined) {
        await Promise.resolve(agent[Symbol.asyncDispose]()).catch(() => undefined);
      }
      await input.removeWorkspace();
    }
  })();

  return {
    result,
    cancel: () => {
      cancellationRequested = true;
      cancelRun();
    },
  };
}

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);
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
      const promptResult = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const metadataWorkspace = yield* fileSystem
            .makeTempDirectory({ prefix: CURSOR_METADATA_WORKSPACE_PREFIX })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "Failed to create an isolated Cursor metadata workspace.",
                    cause,
                  }),
              ),
            );
          const metadataPrompt = [
            "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
            "Return only the requested JSON object.",
            "",
            prompt,
          ].join("\n");
          const agentOptions = {
            apiKey,
            mode: "plan",
            model: cursorSdkModelSelection(modelSelection),
            local: {
              cwd: metadataWorkspace,
              autoReview: false,
              settingSources: [],
              sandboxOptions: { enabled: true },
              enableAgentRetries: true,
            },
          } satisfies AgentOptions;

          const mapCursorSdkError = (cause: unknown) =>
            new TextGenerationError({
              operation,
              detail: "Cursor SDK request failed.",
              cause,
            });
          const request = runCursorSdkRequest({
            agentOptions,
            prompt: metadataPrompt,
            removeWorkspace: () =>
              runPromise(
                ignoreCursorCleanupFailure(
                  fileSystem.remove(metadataWorkspace, { recursive: true, force: true }),
                ),
              ),
          });
          return yield* restore(
            Effect.callback<RunResult, TextGenerationError>((resume) => {
              request.result.then(
                (result) => resume(Effect.succeed(result)),
                (cause) => resume(Effect.fail(mapCursorSdkError(cause))),
              );
              return Effect.sync(request.cancel);
            }),
          );
        }),
      ).pipe(
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
