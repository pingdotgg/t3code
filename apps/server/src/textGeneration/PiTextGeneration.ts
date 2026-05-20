import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type PiSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { type TextGenerationShape } from "./TextGeneration.ts";
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
import { makePiEnvironment } from "../provider/Drivers/PiHome.ts";

const PI_TIMEOUT_MS = 180_000;

const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const piEnvironment = yield* makePiEnvironment(piSettings, environment);

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
        normalizeCliError("pi", operation, cause, "Failed to collect process output"),
      ),
    );

  const runPiJson = Effect.fn("runPiJson")(function* <S extends Schema.Top>({
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
    const runPiCommand = Effect.fn("runPiJson.runPiCommand")(function* () {
      const command = ChildProcess.make(
        piSettings.binaryPath || "pi",
        [
          "--print",
          "--output-format",
          "json",
          ...(modelSelection.model ? ["--model", modelSelection.model] : []),
        ],
        {
          env: piEnvironment,
          cwd,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              Stream.make(
                `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(toJsonSchemaObject(outputSchemaJson))}`,
              ),
            ),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("pi", operation, cause, "Failed to spawn Pi Agent CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", operation, cause, "Failed to read Pi Agent CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Pi Agent CLI command failed: ${detail}`
              : `Pi Agent CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runPiCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Pi Agent CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const jsonMatch = rawStdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return yield* new TextGenerationError({
        operation,
        detail: "Pi Agent CLI did not return valid JSON output.",
      });
    }

    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const parsed = yield* Effect.try({
      try: () => JSON.parse(jsonMatch[0]),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Pi Agent CLI returned malformed JSON.",
          cause,
        }),
    });

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(parsed).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Pi Agent returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "PiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runPiJson({
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
    "PiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runPiJson({
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
    "PiTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runPiJson({
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

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "PiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runPiJson({
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
  } satisfies TextGenerationShape;
});
