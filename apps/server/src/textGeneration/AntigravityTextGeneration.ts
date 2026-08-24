import {
  TextGenerationError,
  type AntigravitySettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAntigravityModel } from "../provider/antigravity/AntigravityCli.ts";
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

const OutputEnvelope = Schema.Struct({ structured_output: Schema.Unknown });
const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(OutputEnvelope));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly schema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const jsonSchema = yield* encodeJson(toJsonSchemaObject(input.schema)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Failed to encode structured output schema.",
              cause,
            }),
        ),
      );
      const binary = settings.binaryPath || "agy";
      const spawn = yield* resolveSpawnCommand(
        binary,
        [
          "-p",
          input.prompt,
          "--output-format",
          "json",
          "--json-schema",
          jsonSchema,
          "--model",
          resolveAntigravityModel(input.modelSelection),
          "--dangerously-skip-permissions",
          "--new-project",
          "--print-timeout",
          "3m",
        ],
        { env: environment },
      );
      const command = ChildProcess.make(spawn.command, spawn.args, {
        env: environment,
        cwd: input.cwd,
        shell: spawn.shell,
        stdin: "ignore",
      });
      const output = yield* Effect.gen(function* () {
        const child = yield* spawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("agy", input.operation, cause, "Failed to spawn Antigravity CLI."),
            ),
          );
        const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
            Effect.mapError((cause) =>
              normalizeCliError("agy", input.operation, cause, "Failed to collect CLI output."),
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        if (Number(exitCode) !== 0) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: stderr.trim() || stdout.trim() || `Antigravity exited with code ${exitCode}.`,
          });
        }
        return stdout;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(180_000),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Antigravity CLI request timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          normalizeCliError("agy", input.operation, cause, "Antigravity CLI request failed."),
        ),
      );
      const envelope = yield* decodeEnvelope(output).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity CLI returned unexpected structured output.",
              cause,
            }),
        ),
      );
      const decodeOutput = Schema.decodeEffect(input.schema);
      return yield* decodeOutput(envelope.structured_output).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity CLI returned invalid structured output.",
              cause,
            }),
        ),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      const built = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt: built.prompt,
        schema: built.outputSchema,
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
      const built = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt: built.prompt,
        schema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const built = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt: built.prompt,
        schema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      const built = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt: built.prompt,
        schema: built.outputSchema,
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
