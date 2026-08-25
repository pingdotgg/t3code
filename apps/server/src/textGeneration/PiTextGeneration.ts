import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TokenBucket } from "@t3tools/shared/rateLimit";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import type { PiSettings, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
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
} from "./TextGenerationUtils.ts";
import { ChildProcess } from "effect/unstable/process";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const PI_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

const runPiJson = <S extends Schema.Top>({
  piSettings,
  environment,
  cwd,
  prompt,
  outputSchemaJson,
}: {
  piSettings: PiSettings;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  outputSchemaJson: S;
}): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const binaryPath = piSettings.binaryPath || "pi";
    const launchArgs = tokenizeCliArgs(piSettings.launchArgs?.trim() ?? "");
    // Use print mode with structured JSON instruction: pi will return assistant text directly.
    // We ask pi to output JSON; then extract JSON blob from stdout.
    const spawnCommand = yield* resolveSpawnCommand(
      binaryPath,
      ["-p", "--no-session", "--no-context-files", ...launchArgs, prompt],
      { env: environment },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            provider: "pi",
            operation: "spawn",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const result = yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        cwd,
        shell: spawnCommand.shell,
      }),
    ).pipe(
      Effect.timeoutFail({
        duration: PI_TIMEOUT_MS,
        onTimeout: () =>
          new TextGenerationError({
            provider: "pi",
            operation: "timeout",
            detail: `Pi text generation timed out after ${PI_TIMEOUT_MS}ms`,
          }),
      }),
      Effect.mapError((cause) => {
        if (isTextGenerationError(cause)) return cause;
        return new TextGenerationError({
          provider: "pi",
          operation: "spawn",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }),
    );

    if (result.code !== 0) {
      const stderr = result.stderr.trim() || result.stdout.trim();
      return yield* new TextGenerationError({
        provider: "pi",
        operation: "spawn",
        detail: stderr || `Pi exited with code ${result.code}`,
      });
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return yield* new TextGenerationError({
        provider: "pi",
        operation: "decode",
        detail: "Pi returned empty output",
      });
    }

    // Try direct JSON, then extract embedded JSON object
    const tryParse = (text: string): unknown | undefined => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };

    let parsed: unknown | undefined = tryParse(stdout);
    if (parsed === undefined) {
      const extracted = extractJsonObject(stdout);
      if (extracted) parsed = tryParse(extracted);
    }
    if (parsed === undefined) {
      // Try to find JSON between ```json blocks
      const fenceMatch = stdout.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch?.[1]) {
        parsed = tryParse(fenceMatch[1].trim());
        if (parsed === undefined) {
          const extracted = extractJsonObject(fenceMatch[1]);
          if (extracted) parsed = tryParse(extracted);
        }
      }
    }
    if (parsed === undefined) {
      return yield* new TextGenerationError({
        provider: "pi",
        operation: "decode",
        detail: `Pi output was not valid JSON: ${stdout.slice(0, 500)}`,
      });
    }

    return yield* Schema.decodeUnknown(Schema.parseJson(outputSchemaJson as any))(JSON.stringify(parsed)).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            provider: "pi",
            operation: "decode",
            detail: cause.message ?? String(cause),
            cause,
          }),
      ),
    ) as any;
  });

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bucket = yield* TokenBucket.make({ capacity: 5, refillPerSecond: 0.5 });

  const withRateLimit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    bucket.take(1).pipe(Effect.flatMap(() => effect));

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) =>
    withRateLimit(
      Effect.gen(function* () {
        const prompt = buildCommitMessagePrompt(input);
        const outputSchemaJson = Schema.Struct({
          commitMessage: Schema.String,
        });
        const result = yield* runPiJson({
          piSettings,
          environment,
          cwd: input.cwd,
          prompt: prompt + "\n\nRespond with JSON: {\"commitMessage\": \"...\"}",
          outputSchemaJson,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        return { commitMessage: sanitizeCommitSubject(result.commitMessage) };
      }),
    );

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) =>
    withRateLimit(
      Effect.gen(function* () {
        const prompt = buildPrContentPrompt(input);
        const outputSchemaJson = Schema.Struct({
          title: Schema.String,
          body: Schema.String,
        });
        const result = yield* runPiJson({
          piSettings,
          environment,
          cwd: input.cwd,
          prompt: prompt + "\n\nRespond with JSON: {\"title\": \"...\", \"body\": \"...\"}",
          outputSchemaJson,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        return {
          title: sanitizePrTitle(result.title),
          body: result.body.trim(),
        };
      }),
    );

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) =>
    withRateLimit(
      Effect.gen(function* () {
        const prompt = buildBranchNamePrompt(input);
        const outputSchemaJson = Schema.Struct({
          branchName: Schema.String,
        });
        const result = yield* runPiJson({
          piSettings,
          environment,
          cwd: input.cwd,
          prompt: prompt + "\n\nRespond with JSON: {\"branchName\": \"...\"}",
          outputSchemaJson,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const fragment = sanitizeBranchFragment(result.branchName);
        return { branchName: sanitizeFeatureBranchName(fragment || result.branchName) };
      }),
    );

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) =>
    withRateLimit(
      Effect.gen(function* () {
        const prompt = buildThreadTitlePrompt(input);
        const outputSchemaJson = Schema.Struct({
          title: Schema.String,
        });
        const result = yield* runPiJson({
          piSettings,
          environment,
          cwd: input.cwd,
          prompt: prompt + "\n\nRespond with JSON: {\"title\": \"...\"}",
          outputSchemaJson,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        return { title: sanitizeThreadTitle(result.title) };
      }),
    );

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
