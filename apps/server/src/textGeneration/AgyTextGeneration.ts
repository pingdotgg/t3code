/**
 * AgyTextGeneration – Text generation layer using the Antigravity CLI (agy).
 *
 * Implements the TextGeneration service contract by delegating to
 * `agy -p --output-format json --json-schema ...`.
 *
 * @module AgyTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type AgySettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { resolveAgyModelForEffort } from "../provider/AgyModelSelection.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const AGY_TIMEOUT_MS = 180_000;

const AgyOutputEnvelope = Schema.Struct({
  status: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
  response: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAgyOutputEnvelope = Schema.decodeEffect(Schema.fromJsonString(AgyOutputEnvelope));

export const makeAgyTextGeneration = Effect.fn("makeAgyTextGeneration")(function* (
  agySettings: AgySettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("agy", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  const runAgyJson = Effect.fn("runAgyJson")(function* <S extends Schema.Top>({
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
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const effort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
    const model = resolveAgyModelForEffort(modelSelection.model, effort);

    const runAgyCommand = Effect.fn("runAgyJson.runAgyCommand")(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        agySettings.binaryPath || "agy",
        [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
          "--dangerously-skip-permissions",
        ],
        { env: environment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        cwd,
        shell: spawnCommand.shell,
      });

      const spawned = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("agy", operation, cause, "Failed to spawn Antigravity CLI"),
          ),
        );

      const outputFiber = yield* Effect.all(
        [
          readStreamAsString(operation, spawned.stdout),
          readStreamAsString(operation, spawned.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      const exitCode = yield* spawned.exitCode.pipe(
        Effect.mapError((cause) =>
          normalizeCliError("agy", operation, cause, "Failed to wait for process exit"),
        ),
      );
      const [stdout, stderr] = yield* Fiber.join(outputFiber);

      return {
        exitCode,
        stdout,
        stderr,
      };
    });

    const result = yield* runAgyCommand().pipe(
      Effect.timeoutOption(AGY_TIMEOUT_MS),
      Effect.flatMap((timedOut) =>
        Option.match(timedOut, {
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Timed out waiting for Antigravity CLI to complete.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.scoped,
    );

    if (result.exitCode !== 0) {
      return yield* new TextGenerationError({
        operation,
        detail:
          result.stderr.trim() ||
          result.stdout.trim() ||
          `Antigravity CLI process exited with code ${result.exitCode}`,
      });
    }

    const envelope = yield* decodeAgyOutputEnvelope(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Antigravity CLI returned unexpected output format.",
            cause,
          }),
      ),
    );

    const payload = envelope.structured_output ?? extractJsonObject(envelope.response ?? "");
    if (!payload) {
      return yield* new TextGenerationError({
        operation,
        detail: envelope.error || "Antigravity CLI returned empty structured output.",
      });
    }

    return yield* Schema.decodeUnknownEffect(outputSchemaJson)(payload).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Antigravity CLI response did not match expected schema.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AgyTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runAgyJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      const branch =
        "branch" in generated && typeof generated.branch === "string"
          ? sanitizeBranchFragment(generated.branch)
          : undefined;

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body?.trim() ?? "",
        ...(branch ? { branch: sanitizeFeatureBranchName(branch) } : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AgyTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runAgyJson({
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
    Effect.fn("AgyTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runAgyJson({
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
    Effect.fn("AgyTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runAgyJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies ProviderInstance["textGeneration"];
});
