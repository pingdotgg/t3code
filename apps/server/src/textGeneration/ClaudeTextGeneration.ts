/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGeneration service contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildAutoReviewFindingsPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildScenerySetPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeScenerySetResult,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "../provider/Layers/ClaudeProvider.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";

const CLAUDE_TIMEOUT_MS = 180_000;

type ClaudeModelCapabilitiesLookup = (model: string | undefined) => ModelCapabilities | undefined;
type ClaudeEffortNormalizer = (
  effort: string | null | undefined,
  model: string | null | undefined,
) => string | undefined;

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * We only care about `structured_output`.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});

const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeClaudeOutputEnvelope = Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope));

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  options?: {
    readonly getModelCapabilities?: ClaudeModelCapabilitiesLookup;
    readonly normalizeEffort?: ClaudeEffortNormalizer;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);

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
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  type ClaudeTextGenerationOp =
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle"
    | "generateScenerySet"
    | "generateAutoReviewFindings";

  const encodeJsonForOperation = (
    operation: ClaudeTextGenerationOp,
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

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: ClaudeTextGenerationOp;
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
    const caps =
      options?.getModelCapabilities?.(modelSelection.model) ??
      getClaudeModelCapabilities(modelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: modelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(modelSelection, "effort");
    const resolvedEffort = resolveClaudeEffort(caps, rawEffortSelection);
    const cliEffort = (options?.normalizeEffort ?? normalizeClaudeCliEffort)(
      resolvedEffort,
      modelSelection.model,
    );
    const ultracode = isClaudeUltracodeEffort(resolvedEffort);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    };
    const settingsJson =
      Object.keys(settings).length > 0
        ? yield* encodeJsonForOperation(
            operation,
            settings,
            "Failed to encode Claude CLI settings.",
          )
        : undefined;

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeApiModelId(modelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          ...(settingsJson ? ["--settings", settingsJson] : []),
          "--dangerously-skip-permissions",
        ],
        { env: claudeEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: claudeEnvironment,
        cwd,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
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
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const envelope = yield* decodeClaudeOutputEnvelope(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGeneration service methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ClaudeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runClaudeJson({
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
    Effect.fn("ClaudeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runClaudeJson({
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
    Effect.fn("ClaudeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runClaudeJson({
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
    Effect.fn("ClaudeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runClaudeJson({
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

  const generateScenerySet: TextGeneration.TextGeneration["Service"]["generateScenerySet"] =
    Effect.fn("ClaudeTextGeneration.generateScenerySet")(function* (input) {
      const location = input.location.trim();
      if (location.length === 0) {
        return yield* new TextGenerationError({
          operation: "generateScenerySet",
          detail: "Location must not be empty.",
        });
      }

      const { prompt, outputSchema } = buildScenerySetPrompt({ location });
      const generated = yield* runClaudeJson({
        operation: "generateScenerySet",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      const sanitized = sanitizeScenerySetResult(generated);
      if (sanitized.sceneNames.length === 0 || sanitized.queries.length === 0) {
        return yield* new TextGenerationError({
          operation: "generateScenerySet",
          detail: "Claude returned an empty scenery set.",
        });
      }
      return sanitized;
    });

  const generateAutoReviewFindings: TextGeneration.TextGeneration["Service"]["generateAutoReviewFindings"] =
    Effect.fn("ClaudeTextGeneration.generateAutoReviewFindings")(function* (input) {
      const { prompt, outputSchema } = buildAutoReviewFindingsPrompt({
        prNumber: input.prNumber,
        prTitle: input.prTitle,
        prBody: input.prBody,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        headSha: input.headSha,
        diffPatch: input.diffPatch,
        truncated: input.truncated,
      });

      const generated = yield* runClaudeJson({
        operation: "generateAutoReviewFindings",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        summary: generated.summary.trim(),
        decision: generated.decision,
        comments: generated.comments.map((comment) => ({
          path: comment.path.trim(),
          line:
            comment.line !== null && Number.isSafeInteger(comment.line) && comment.line > 0
              ? comment.line
              : null,
          side: comment.side,
          severity: comment.severity,
          body: comment.body.trim(),
        })),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateScenerySet,
    generateAutoReviewFindings,
  } satisfies TextGeneration.TextGeneration["Service"];
});
