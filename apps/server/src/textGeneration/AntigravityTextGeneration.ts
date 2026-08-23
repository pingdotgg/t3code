import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type AntigravitySettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { normalizeAntigravityModel } from "../provider/Layers/AntigravityProvider.ts";
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
const isTextGenerationError = Schema.is(TextGenerationError);

function parseAgyTextGenLine(line: string): { textDelta?: string; response?: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    if (
      parsed.event === "step_update" &&
      parsed.step_update &&
      typeof (parsed.step_update as { text_delta?: unknown }).text_delta === "string"
    ) {
      return { textDelta: (parsed.step_update as { text_delta: string }).text_delta };
    }
    if (
      parsed.event === "result" &&
      parsed.result &&
      typeof (parsed.result as { response?: unknown }).response === "string"
    ) {
      return { response: (parsed.result as { response: string }).response };
    }
  } catch {
    // ignore malformed JSON lines
  }
  return undefined;
}

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  antigravityConfig: AntigravitySettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const runAgyJson = <S extends Schema.Top>({
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
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const binary = antigravityConfig.binaryPath || "agy";
      const model = modelSelection.model || "gemini-3.7-flash";
      const effort = getProviderOptionStringSelectionValue(modelSelection.options, "effort");
      const normalizedModel = normalizeAntigravityModel(model, effort ?? undefined);

      const cliArgs: string[] = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--model",
        normalizedModel,
        "--dangerously-skip-permissions",
      ];

      const spawnCommand = yield* resolveSpawnCommand(binary, cliArgs, {
        env: resolvedEnvironment,
      });

      const outputRef = yield* Ref.make("");
      const stdoutRemainderRef = yield* Ref.make("");

      const runProcess = Effect.gen(function* () {
        const child = yield* commandSpawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: resolvedEnvironment,
            cwd,
            shell: spawnCommand.shell,
          }),
        );

        const stdoutFiber = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.modify(stdoutRemainderRef, (current) => {
              const combined = current + chunk;
              const lines = combined.split("\n");
              const remainder = lines.pop() ?? "";
              return [lines.map((l) => l.replace(/\r$/, "")), remainder] as const;
            }).pipe(
              Effect.flatMap((lines) =>
                Effect.forEach(
                  lines,
                  (line) => {
                    const parsed = parseAgyTextGenLine(line);
                    if (parsed?.textDelta) {
                      return Ref.update(outputRef, (curr) => curr + parsed.textDelta);
                    }
                    if (parsed?.response) {
                      return Ref.set(outputRef, parsed.response);
                    }
                    return Effect.void;
                  },
                  { discard: true },
                ),
              ),
            ),
          ),
          Effect.forkScoped,
        );

        const stderrFiber = yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach(() => Effect.void),
          Effect.forkScoped,
        );

        const exitCode = yield* child.exitCode;
        yield* Fiber.join(stdoutFiber).pipe(Effect.catch(() => Effect.void));
        yield* Fiber.join(stderrFiber).pipe(Effect.catch(() => Effect.void));

        const finalRemainder = yield* Ref.get(stdoutRemainderRef);
        const parsedFinal = parseAgyTextGenLine(finalRemainder);
        if (parsedFinal?.textDelta) {
          yield* Ref.update(outputRef, (curr) => curr + parsedFinal.textDelta);
        }
        if (parsedFinal?.response) {
          yield* Ref.set(outputRef, parsedFinal.response);
        }

        yield* Effect.yieldNow;

        if (exitCode !== 0) {
          return yield* new TextGenerationError({
            operation,
            detail: `Antigravity CLI exited with code ${exitCode}.`,
          });
        }
      }).pipe(
        Effect.timeoutOption(ANTIGRAVITY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Antigravity CLI request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.scoped,
      );

      yield* runProcess.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : normalizeCliError(
                "antigravity",
                operation,
                cause,
                "Antigravity text generation failed",
              ),
        ),
      );

      const accumulatedText = (yield* Ref.get(outputRef)).trim();
      if (!accumulatedText) {
        return yield* new TextGenerationError({
          operation,
          detail: "Antigravity CLI returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(accumulatedText)).pipe(
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

      const generated = yield* runAgyJson({
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
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        policy: input.policy,
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
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
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
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
