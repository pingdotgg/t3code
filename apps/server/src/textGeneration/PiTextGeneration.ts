import { TextGenerationError, type ModelSelection, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { splitPiModelSlug } from "../provider/Layers/PiProvider.ts";
import {
  makePiRpcTransport,
  type PiRpcResponse,
} from "../orchestration-v2/Adapters/PiRpcTransport.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

type PiTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const isTextGenerationError = Schema.is(TextGenerationError);

function responseData(response: PiRpcResponse | undefined): Record<string, unknown> | undefined {
  if (response?.["success"] !== true) return undefined;
  const data = response["data"];
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

function thinkingLevel(selection: ModelSelection): string | undefined {
  return (
    getModelSelectionStringOptionValue(selection, "thinking") ??
    getModelSelectionStringOptionValue(selection, "reasoningEffort")
  );
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = Effect.fn("PiTextGeneration.runPiJson")(function* <
    S extends Schema.Top,
  >(input: {
    readonly operation: PiTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }) {
    const model = splitPiModelSlug(input.modelSelection.model);
    if (model === undefined) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Pi model selection must use the 'provider/model' format.",
      });
    }

    const rawText = yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makePiRpcTransport({
          command: settings.binaryPath || "pi",
          args: [
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            ...tokenizeCliArgs(settings.launchArgs),
          ],
          cwd: input.cwd,
          env: environment,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const setModel = yield* transport.request(
          { type: "set_model", provider: model.provider, modelId: model.id },
          15_000,
        );
        if (setModel?.["success"] !== true) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: `Pi rejected model ${input.modelSelection.model}.`,
          });
        }
        const thinking = thinkingLevel(input.modelSelection);
        if (
          thinking === "off" ||
          thinking === "minimal" ||
          thinking === "low" ||
          thinking === "medium" ||
          thinking === "high" ||
          thinking === "xhigh" ||
          thinking === "max"
        ) {
          const setThinking = yield* transport.request(
            { type: "set_thinking_level", level: thinking },
            15_000,
          );
          if (setThinking?.["success"] !== true) {
            return yield* new TextGenerationError({
              operation: input.operation,
              detail: `Pi rejected thinking level ${thinking}.`,
            });
          }
        }

        const settled = yield* Stream.fromQueue(transport.messages).pipe(
          Stream.takeUntil(
            (message) => message._tag === "event" && message.event["type"] === "agent_settled",
          ),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        );
        const prompted = yield* transport.request(
          { type: "prompt", message: input.prompt },
          15_000,
        );
        if (prompted?.["success"] !== true) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi rejected the text-generation prompt.",
          });
        }
        yield* Fiber.join(settled).pipe(Effect.timeout("2 minutes"));
        const response = yield* transport.request({ type: "get_last_assistant_text" }, 15_000);
        const text = responseData(response)?.["text"];
        if (typeof text !== "string" || text.trim().length === 0) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi returned no assistant text.",
          });
        }
        return text.trim();
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Pi RPC text generation failed.",
              cause,
            }),
      ),
    );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
    return yield* decodeOutput(extractJsonObject(rawText)).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Pi returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
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
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
