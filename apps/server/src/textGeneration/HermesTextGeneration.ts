/**
 * HermesTextGeneration — text generation via the Hermes CLI in scripted mode.
 *
 * Implements the same `TextGeneration` service contract as the other
 * providers but delegates to `hermes -z "<prompt>" --model <slug>`. `-z` is
 * Hermes' pure one-shot entry point: single prompt in, final response text
 * out, nothing else on stdout or stderr (documented in the Hermes CLI
 * reference). Hermes has no `--output-format json` flag, so the prompt asks
 * the model to return a single JSON object and we extract + decode it from
 * the printed reply — the same approach PiAgentTextGeneration and
 * GrokTextGeneration use.
 *
 * @module textGeneration/HermesTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type HermesSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
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
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const HERMES_TIMEOUT_MS = 180_000;
const HERMES_HOME_ENV = "HERMES_HOME";

export const makeHermesTextGeneration = Effect.fn("makeHermesTextGeneration")(function* (
  hermesSettings: HermesSettings,
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
        normalizeCliError("hermes", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Spawn the Hermes CLI in `-z` scripted mode with a JSON-producing prompt
   * and return the parsed, schema-validated result.
   */
  const runHermesJson = Effect.fn("runHermesJson")(function* <S extends Schema.Top>({
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
    const runHermesCommand = Effect.fn("runHermesJson.runHermesCommand")(function* () {
      const profile = hermesSettings.profile?.trim();
      const homePath = hermesSettings.homePath?.trim();
      const spawnCommand = yield* resolveSpawnCommand(
        hermesSettings.binaryPath || "hermes",
        [
          ...(profile ? (["--profile", profile] as const) : []),
          "-z",
          prompt,
          "--model",
          modelSelection.model,
        ],
        {
          env: {
            ...environment,
            ...(homePath ? { [HERMES_HOME_ENV]: homePath } : {}),
          },
        },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: {
          ...environment,
          ...(homePath ? { [HERMES_HOME_ENV]: homePath } : {}),
        },
        cwd,
        shell: spawnCommand.shell,
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("hermes", operation, cause, "Failed to spawn Hermes CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("hermes", operation, cause, "Failed to read Hermes CLI exit code"),
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
              ? `Hermes CLI command failed: ${detail}`
              : `Hermes CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runHermesCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(HERMES_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Hermes CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const trimmed = rawStdout.trim();
    if (!trimmed) {
      return yield* new TextGenerationError({
        operation,
        detail: "Hermes returned empty output.",
      });
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Hermes returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("HermesTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runHermesJson({
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
    Effect.fn("HermesTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runHermesJson({
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
    Effect.fn("HermesTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runHermesJson({
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
    Effect.fn("HermesTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runHermesJson({
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
  } satisfies TextGeneration.TextGeneration["Service"];
});
