import { TextGenerationError, type ModelSelection, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { decodePiModelSlug } from "../provider/pi/PiModel.ts";
import {
  makePiRpcClient,
  type PiRpcClient,
  type PiRpcError,
  type PiRpcSpawnOptions,
} from "../provider/pi/PiRpcClient.ts";
import { PiThinkingLevel } from "../provider/pi/PiRpcSchema.ts";
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

const DETERMINISTIC_ARGS = ["--no-session", "--offline"] as const;
type PiRpcClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;
const isTextGenerationError = Schema.is(TextGenerationError);
const decodePiThinkingLevel = Schema.decodeUnknownEffect(PiThinkingLevel);
export const PI_TEXT_GENERATION_TIMEOUT_MS = 120_000;

export interface PiTextGenerationOptions {
  readonly timeoutMs?: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const assistantText = (message: Record<string, unknown>): string | undefined => {
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map(record)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text)
    .join("");
  return text || undefined;
};

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeRpcClient: PiRpcClientFactory = makePiRpcClient,
  options: PiTextGenerationOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runJson = <S extends Schema.Top>(input: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = decodePiModelSlug(input.modelSelection.model);
        if (!selected)
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi model selection must use the 'provider/model' format.",
          });
        const client = yield* makeRpcClient({
          command: settings.binaryPath,
          args: DETERMINISTIC_ARGS,
          cwd: input.cwd,
          env: environment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to start Pi RPC text generation.",
                cause,
              }),
          ),
        );
        const output = yield* Ref.make("");
        const currentDeltas = yield* Ref.make("");
        const settled = yield* Deferred.make<void, TextGenerationError>();
        yield* client.events.pipe(
          Stream.runForEach((native) => {
            if ("_tag" in native && native._tag === "PiRpcProtocolFailureEvent")
              return Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Pi RPC protocol failed before generation settled.",
                  cause: native,
                }),
              ).pipe(Effect.asVoid);
            const event = native as Record<string, unknown>;
            if (event.type === "agent_settled")
              return Deferred.succeed(settled, undefined).pipe(Effect.asVoid);
            if (event.type === "message_start") return Ref.set(currentDeltas, "");
            if (event.type === "message_end") {
              const message = record(event.message);
              if (!message || message.role !== "assistant") return Effect.void;
              const stopReason = message.stopReason;
              if (stopReason === "error" || stopReason === "aborted")
                return Deferred.fail(
                  settled,
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `Pi assistant stopped with reason '${stopReason}'.`,
                  }),
                ).pipe(Effect.asVoid);
              return Effect.gen(function* () {
                const completed = assistantText(message) ?? (yield* Ref.get(currentDeltas));
                yield* Ref.set(output, completed);
                yield* Ref.set(currentDeltas, "");
              });
            }
            const update = event.assistantMessageEvent;
            if (
              event.type === "message_update" &&
              typeof update === "object" &&
              update !== null &&
              "type" in update &&
              update.type === "text_delta" &&
              "delta" in update &&
              typeof update.delta === "string"
            )
              return Ref.update(currentDeltas, (current) => current + update.delta);
            return Effect.void;
          }),
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: Cause.hasInterruptsOnly(cause)
                    ? "Pi event stream ended before generation settled."
                    : "Pi event stream failed before generation settled.",
                  ...(Cause.hasInterruptsOnly(cause) ? {} : { cause }),
                }),
              ),
            onSuccess: () =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Pi event stream ended before generation settled.",
                }),
              ),
          }),
          Effect.asVoid,
          Effect.forkScoped,
        );
        yield* client.setModel(selected.provider, selected.modelId);
        const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel");
        if (thinking !== undefined) {
          const level = yield* decodePiThinkingLevel(thinking);
          yield* client.setThinkingLevel(level);
        }
        yield* client.prompt(input.prompt);
        yield* Deferred.await(settled);
        const raw = (yield* Ref.get(output)).trim();
        if (!raw)
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi returned empty output.",
          });
        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
        return yield* decodeOutput(extractJsonObject(raw));
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Pi text generation failed.",
                cause,
              }),
        ),
      ),
    ).pipe(
      Effect.timeout(Duration.millis(options.timeoutMs ?? PI_TEXT_GENERATION_TIMEOUT_MS)),
      Effect.catchTags({
        TimeoutError: () =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Pi text generation timed out.",
          }),
      }),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) => {
    const built = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    return runJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt: built.prompt,
      outputSchema: built.outputSchema,
      modelSelection: input.modelSelection,
    }).pipe(
      Effect.map((value) => ({
        subject: sanitizeCommitSubject(value.subject),
        body: value.body.trim(),
        ...("branch" in value && typeof value.branch === "string"
          ? { branch: sanitizeFeatureBranchName(value.branch) }
          : {}),
      })),
    );
  };
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) => {
    const built = buildPrContentPrompt(input);
    return runJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt: built.prompt,
      outputSchema: built.outputSchema,
      modelSelection: input.modelSelection,
    }).pipe(
      Effect.map((value) => ({ title: sanitizePrTitle(value.title), body: value.body.trim() })),
    );
  };
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) => {
    const built = buildBranchNamePrompt(input);
    return runJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt: built.prompt,
      outputSchema: built.outputSchema,
      modelSelection: input.modelSelection,
    }).pipe(Effect.map((value) => ({ branch: sanitizeBranchFragment(value.branch) })));
  };
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) => {
    const built = buildThreadTitlePrompt(input);
    return runJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt: built.prompt,
      outputSchema: built.outputSchema,
      modelSelection: input.modelSelection,
    }).pipe(Effect.map((value) => ({ title: sanitizeThreadTitle(value.title) })));
  };
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
