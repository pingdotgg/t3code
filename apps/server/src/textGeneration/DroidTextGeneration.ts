import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type DroidSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import {
  DROID_SESSION_REQUEST_TIMEOUT_MS,
  makeDroidExecRpcClient,
} from "../provider/droid/DroidRpcClient.ts";
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
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const DROID_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const isTextGenerationError = Schema.is(TextGenerationError);
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
type DroidTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeDroidTextGeneration = Effect.fn("makeDroidTextGeneration")(function* (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { randomUUIDv4 } = yield* Crypto.Crypto;

  const runDroidJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
  }: {
    operation: DroidTextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const failWith = (detail: string, cause?: unknown) =>
        new TextGenerationError({
          operation,
          detail,
          ...(cause !== undefined ? { cause } : {}),
        });
      const mapRpcError =
        (detail: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.mapError((cause) => failWith(detail, cause)));
      const rpc = yield* makeDroidExecRpcClient({
        binaryPath: droidSettings.binaryPath,
        cwd,
        env: environment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
        mapRpcError("Failed to start the Droid CLI."),
      );

      let structuredOutput: Record<string, unknown> | null | undefined;
      const turnDone = yield* Deferred.make<string | undefined, TextGenerationError>();
      const failTurn = (detail: string, cause?: unknown) =>
        Deferred.fail(turnDone, failWith(detail, cause)).pipe(Effect.asVoid);

      yield* Stream.runDrain(
        Stream.mapEffect(rpc.notifications, ({ notification }) => {
          switch (notification.type) {
            case "structured_output":
              return encodeJson(notification.structuredOutput).pipe(
                Effect.flatMap((encodedOutput) => {
                  if (Buffer.byteLength(encodedOutput, "utf8") > MAX_OUTPUT_BYTES)
                    return failTurn(`Droid output exceeded the ${MAX_OUTPUT_BYTES}-byte limit.`);
                  structuredOutput = notification.structuredOutput;
                  return Effect.void;
                }),
                Effect.catchTags({
                  SchemaError: (cause) =>
                    failTurn("Droid returned invalid structured output.", cause),
                }),
              );
            case "agent_turn_completed":
              return Deferred.succeed(turnDone, notification.reason).pipe(Effect.asVoid);
            default:
              return Effect.void;
          }
        }),
      ).pipe(Effect.forkScoped);

      const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
      yield* rpc
        .request(
          "droid.initialize_session",
          {
            machineId: "default",
            cwd,
            autonomyLevel: "off",
            interactionMode: "auto",
            restrictToolIds: ["t3_text_generation"],
            blockOnMcpLoad: false,
            ...(modelSelection.model ? { modelId: modelSelection.model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          },
          { timeoutMs: DROID_SESSION_REQUEST_TIMEOUT_MS },
        )
        .pipe(mapRpcError("Failed to initialize Droid session."));

      yield* rpc
        .request("droid.add_user_message", {
          messageId: yield* randomUUIDv4,
          text: prompt,
          outputFormat: {
            type: "json_schema",
            schema: toJsonSchemaObject(outputSchema),
          },
        })
        .pipe(mapRpcError("Droid rejected the prompt."));

      const completionReason = yield* Effect.raceFirst(
        Deferred.await(turnDone),
        Effect.flatMap(rpc.exits, (exit) =>
          Effect.fail(
            failWith(`Droid exited before completing the request (${exit.description}).`),
          ),
        ),
      ).pipe(
        Effect.timeoutOption(DROID_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failWith("Droid request timed out.")),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      if (completionReason !== "completed")
        return yield* failWith(
          completionReason === "cancelled"
            ? "Droid request was cancelled."
            : `Droid request failed (${completionReason ?? "unknown reason"}).`,
        );
      if (structuredOutput === undefined || structuredOutput === null)
        return yield* failWith("Droid returned no structured output.");

      return yield* Schema.decodeUnknownEffect(outputSchema)(structuredOutput).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(failWith("Droid returned invalid structured output.", cause)),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Droid text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generate = <P, S extends Schema.Top, O>(
    operation: DroidTextGenerationOperation,
    buildPrompt: (input: P) => { readonly prompt: string; readonly outputSchema: S },
    sanitize: (generated: S["Type"]) => O,
  ) =>
    Effect.fn(`DroidTextGeneration.${operation}`)(function* (
      input: P & { readonly cwd: string; readonly modelSelection: ModelSelection },
    ) {
      const { prompt, outputSchema } = buildPrompt(input);
      const generated = yield* runDroidJson({
        operation,
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return sanitize(generated);
    });

  return {
    generateCommitMessage: generate(
      "generateCommitMessage",
      buildCommitMessagePrompt,
      (generated) => ({
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      }),
    ),
    generatePrContent: generate("generatePrContent", buildPrContentPrompt, (generated) => ({
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    })),
    generateBranchName: generate("generateBranchName", buildBranchNamePrompt, (generated) => ({
      branch: sanitizeBranchFragment(generated.branch),
    })),
    generateThreadTitle: generate("generateThreadTitle", buildThreadTitlePrompt, (generated) => ({
      title: sanitizeThreadTitle(generated.title),
    })),
  } satisfies TextGeneration.TextGeneration["Service"];
});
