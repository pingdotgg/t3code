import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import type { PiSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { ChildProcess } from "effect/unstable/process";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { makeStandardTextGeneration, type RunJson } from "./makeStandardTextGeneration.ts";

const PI_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runJson: RunJson = Effect.fn("PiTextGeneration.runJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection: _modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: import("@t3tools/contracts").ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const binaryPath = piSettings.binaryPath || "pi";
    const launchArgs = tokenizeCliArgs(piSettings.launchArgs?.trim() ?? "");
    const filteredLaunchArgs = launchArgs.filter(
      (arg) =>
        arg !== "--tools" &&
        arg !== "--extension" &&
        !arg.startsWith("--tools=") &&
        !arg.startsWith("--extension="),
    );
    const spawnCommand = yield* resolveSpawnCommand(
      binaryPath,
      [
        "-p",
        "--no-session",
        "--no-context-files",
        "--no-tools",
        "--no-extensions",
        ...filteredLaunchArgs,
        prompt,
      ],
      { env: environment },
    ).pipe(
      Effect.mapError(
        (cause: unknown) =>
          new TextGenerationError({
            operation,
            detail: (cause as { message?: string })?.message ?? String(cause),
            cause,
          }),
      ),
    );

    const resultOption = yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        cwd,
        shell: spawnCommand.shell,
      }),
    ).pipe(
      Effect.mapError((cause: unknown) => {
        if (isTextGenerationError(cause)) return cause as TextGenerationError;
        return new TextGenerationError({
          operation,
          detail: (cause as { message?: string })?.message ?? String(cause),
          cause,
        });
      }),
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const result = yield* Option.match(resultOption, {
      onNone: () =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: `Pi text generation timed out after ${PI_TIMEOUT_MS}ms`,
          }),
        ),
      onSome: (value) => Effect.succeed(value),
    }).pipe(
      Effect.mapError((cause: unknown) => {
        if (isTextGenerationError(cause)) return cause as TextGenerationError;
        return new TextGenerationError({
          operation,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }),
    );

    if (result.code !== 0) {
      const stderr = result.stderr.trim() || result.stdout.trim();
      return yield* new TextGenerationError({
        operation,
        detail: stderr || `Pi exited with code ${result.code}`,
      });
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return yield* new TextGenerationError({
        operation,
        detail: "Pi returned empty output",
      });
    }

    // Single salvage via shared helper — `extractJsonObject` already handles ```json fences.
    const jsonText = extractJsonObject(stdout) ?? stdout;
    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson as any))(
      jsonText,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: cause.message ?? String(cause),
            cause,
          }),
      ),
    ) as any;
  });

  return makeStandardTextGeneration(runJson);
});
