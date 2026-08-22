import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type AntigravitySettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

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

const ANTIGRAVITY_TIMEOUT_MS = 180_000;
const decodeJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  settings: AntigravitySettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processEnv = environment ?? process.env;

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
        normalizeCliError("antigravity", operation, cause, "Failed to collect process output"),
      ),
    );

  const runAntigravityJson = Effect.fn("runAntigravityJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const binary = settings.binaryPath || "agy";
    const args = ["-p", prompt, "--output-format", "stream-json"];

    if (settings.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    if (settings.effort) {
      args.push("--effort", settings.effort);
    }

    if (modelSelection.model) {
      args.push("--model", modelSelection.model);
    }

    const spawnCommand = yield* resolveSpawnCommand(binary, args, {
      env: processEnv,
    });

    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: processEnv,
      shell: spawnCommand.shell,
    });

    const processHandle = yield* commandSpawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError(
            "antigravity",
            operation,
            cause,
            `Failed to spawn Antigravity CLI process (${binary})`,
          ),
        ),
      );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStreamAsString(operation, processHandle.stdout),
        readStreamAsString(operation, processHandle.stderr),
        processHandle.exitCode.pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "antigravity",
              operation,
              cause,
              "Failed to read Antigravity CLI exit code",
            ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeoutOption(ANTIGRAVITY_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Antigravity CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    if (exitCode !== 0) {
      return yield* new TextGenerationError({
        operation,
        detail: `Antigravity CLI command failed with code ${exitCode}.`,
      });
    }

    let responseText = "";
    const lines = stdout.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const decoded = decodeJsonExit(trimmed);
      if (Exit.isSuccess(decoded) && typeof decoded.value === "object" && decoded.value !== null) {
        const parsed = decoded.value as Record<string, unknown>;
        const resultRecord =
          typeof parsed.result === "object" && parsed.result !== null
            ? (parsed.result as Record<string, unknown>)
            : undefined;
        const stepRecord =
          typeof parsed.step_update === "object" && parsed.step_update !== null
            ? (parsed.step_update as Record<string, unknown>)
            : undefined;

        if (parsed.event === "result" && typeof resultRecord?.response === "string") {
          responseText = resultRecord.response;
        } else if (parsed.event === "step_update" && typeof stepRecord?.text_delta === "string") {
          responseText += stepRecord.text_delta;
        }
      }
    }

    if (!responseText) {
      responseText = stdout;
    }

    const jsonSnippet = extractJsonObject(responseText);
    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
    return yield* decodeOutput(jsonSnippet).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Antigravity returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runAntigravityJson({
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
    Effect.fn("AntigravityTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runAntigravityJson({
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
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runAntigravityJson({
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
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runAntigravityJson({
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
