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
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type ClaudeSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBoardProposalPrompt,
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

/**
 * Permission posture for a Claude CLI invocation.
 *
 * - `"skip-permissions"` passes `--dangerously-skip-permissions`, which grants
 *   the agent full tool/filesystem access. Used for the git text-generation ops
 *   where the model only emits structured JSON but historically ran with
 *   skip-permissions.
 * - `"no-tool"` loads ZERO tools regardless of the machine's permission/settings
 *   /MCP config. Per `claude --help`:
 *     - `--tools ""` disables all tools from the BUILT-IN set ONLY. It does NOT
 *       affect MCP-server tools (from `~/.claude.json` etc.), which would
 *       otherwise stay loaded and — under an auto-approve permission mode or a
 *       write/bash-capable MCP server — let the agent write `.t3/boards/*.json`
 *       and bypass the human approval gate.
 *     - `--strict-mcp-config` makes Claude "Only use MCP servers from
 *       --mcp-config, ignoring all other MCP configurations".
 *     - `--mcp-config "{}"` supplies an EMPTY MCP server set.
 *   Together (`--strict-mcp-config --mcp-config "{}" --tools ""`) NO built-in
 *   tools and NO MCP tools are loaded — independent of permission mode. This is
 *   the architectural guarantee for the self-improving-boards meta-agent: it can
 *   reason and emit a proposal but physically cannot apply it.
 */
export type ClaudePermissionPosture = "skip-permissions" | "no-tool";

/**
 * Pure builder for the Claude CLI argument vector. Extracted so the no-tool
 * guarantee can be unit-asserted without spawning a process (a live MCP test
 * isn't possible in CI): a `"no-tool"` posture MUST emit
 * `--strict-mcp-config`, `--mcp-config "{}"`, and `--tools ""`, and MUST NOT
 * emit `--dangerously-skip-permissions`.
 *
 * NOTE on ordering: `--tools` and `--mcp-config` are variadic, so any flag
 * placed AFTER them could be swallowed as a value. The no-tool flags are
 * emitted LAST, with `--tools ""` the very last pair (only the stdin-fed prompt
 * follows). `--strict-mcp-config` is a boolean flag (takes no value) so it is
 * safe to place before `--mcp-config "{}"`.
 */
export const buildClaudeProposalArgs = (input: {
  readonly jsonSchemaStr: string;
  readonly model: string;
  readonly cliEffort: string | undefined;
  readonly settingsJson: string | undefined;
  readonly posture: ClaudePermissionPosture;
}): ReadonlyArray<string> => [
  "-p",
  "--output-format",
  "json",
  "--json-schema",
  input.jsonSchemaStr,
  "--model",
  input.model,
  ...(input.cliEffort ? ["--effort", input.cliEffort] : []),
  ...(input.settingsJson ? ["--settings", input.settingsJson] : []),
  // SAFETY: the posture decides tool access. `"no-tool"` loads zero tools
  // (no built-ins via `--tools ""`, no MCP via `--strict-mcp-config` +
  // `--mcp-config "{}"`); `"skip-permissions"` grants full access.
  ...(input.posture === "no-tool"
    ? ["--strict-mcp-config", "--mcp-config", "{}", "--tools", ""]
    : ["--dangerously-skip-permissions"]),
];

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
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const fileSystem = yield* FileSystem.FileSystem;

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

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateBoardProposal",
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
    posture = "skip-permissions",
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateBoardProposal";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
    /**
     * Permission posture. Defaults to `"skip-permissions"` (the existing git
     * ops). The board-proposal op passes `"no-tool"` so the meta-agent cannot
     * use any tools.
     */
    posture?: ClaudePermissionPosture;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeModelCapabilities(modelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: modelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(modelSelection, "effort");
    const resolvedEffort = resolveClaudeEffort(caps, rawEffortSelection);
    const cliEffort = normalizeClaudeCliEffort(resolvedEffort, modelSelection.model);
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
          ...buildClaudeProposalArgs({
            jsonSchemaStr,
            model: resolveClaudeApiModelId(modelSelection),
            cliEffort,
            settingsJson,
            posture,
          }),
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

  const generateBoardProposal: TextGeneration.TextGeneration["Service"]["generateBoardProposal"] =
    Effect.fn("ClaudeTextGeneration.generateBoardProposal")(function* (input) {
      const { prompt, outputSchema } = buildBoardProposalPrompt({ prompt: input.prompt });

      // SAFETY (defense-in-depth): run the no-tool op in a throwaway temp dir
      // rather than the repo root, which holds `.t3/boards/*.json`. The no-tool
      // posture already loads zero tools, but pointing cwd away from the board
      // files shrinks the blast radius if anything ever slips. The scoped temp
      // dir is removed when the effect completes.
      const generated = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-board-proposal-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateBoardProposal",
                detail: "Failed to create sandbox working directory for board proposal.",
                cause,
              }),
          ),
          Effect.flatMap((sandboxCwd) =>
            runClaudeJson({
              operation: "generateBoardProposal",
              cwd: sandboxCwd,
              prompt,
              outputSchemaJson: outputSchema,
              modelSelection: input.modelSelection,
              // SAFETY: no-tool posture — the meta-agent cannot write a board def.
              posture: "no-tool",
            }),
          ),
          Effect.scoped,
        );

      return {
        proposedDefinition: generated.proposedDefinition,
        rationale: generated.rationale.trim(),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateBoardProposal,
  } satisfies TextGeneration.TextGeneration["Service"];
});
