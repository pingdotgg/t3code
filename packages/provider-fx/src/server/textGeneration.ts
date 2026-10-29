import { TextGenerationError } from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  isCommandMissingCause,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { FxSettings } from "../settings.ts";
import { FX_DEFAULT_MODEL_SLUG, FX_EFFORT_OPTION_DESCRIPTOR } from "./acpSupport.ts";

const FX_TIMEOUT_MS = 180_000;

/** `fx ask --json` from fx 0.0.15; `error` names the failure when `exit_code` is non-zero. */
const FxAskResult = Schema.fromJsonString(
  Schema.Struct({
    final_output: Schema.String,
    error: Schema.optional(Schema.String),
  }),
);
const decodeFxAskResult = Schema.decodeUnknownOption(FxAskResult);

const isTextGenerationError = Schema.is(TextGenerationError);

// fx's stderr can echo prompt or tool text, so it never reaches the client-visible error.
const FX_ASK_ERROR_DETAILS: Record<string, string> = {
  NonInteractivePermissionRequired:
    "fx asked for approval to use a tool. Text generation runs fx without approvals.",
  MissingCredentials: "fx is not signed in. Run `fx login` on the machine running T3 Code.",
};

function fxAskFailureDetail(code: number, stdout: string): string {
  const error = Option.getOrUndefined(decodeFxAskResult(stdout.trim()))?.error;
  if (error === undefined || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error)) {
    return `fx ask exited with code ${code}.`;
  }
  return FX_ASK_ERROR_DETAILS[error] ?? `fx ask failed with ${error}.`;
}

/**
 * Runs `fx ask --no-save`, which keeps the request out of fx's session store.
 * An empty working directory keeps project rules, skills and settings out of
 * the run; every prompt here carries what it needs.
 */
export const makeFxTextGeneration = Effect.fn("makeFxTextGeneration")(function* (
  fxSettings: FxSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  // A saved `yolo` or `auto` default would let tool calls write unattended;
  // in `ask` mode a headless run fails instead of writing.
  const env = { ...environment, FX_PERMISSION_MODE: "ask" };

  const runFxJson: TextGenerationOperations.Runner = Effect.fn("FxTextGeneration.runFxJson")(
    function* (request) {
      const { operation, prompt, modelSelection } = request;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fx-text-" });
      const model = modelSelection.model.trim();
      // Like the ACP adapter, an unset effort runs at the picker's default.
      const effort =
        getModelSelectionStringOptionValue(modelSelection, FX_EFFORT_OPTION_DESCRIPTOR.id) ??
        getProviderOptionCurrentValue(FX_EFFORT_OPTION_DESCRIPTOR);
      const args = [
        "ask",
        "--no-save",
        "--json",
        ...(model.length === 0 || model === FX_DEFAULT_MODEL_SLUG ? [] : ["--model", model]),
        ...(typeof effort === "string" ? ["--effort", effort] : []),
      ];
      const command = fxSettings.binaryPath || "fx";
      const spawnCommand = yield* resolveSpawnCommand(command, args, { env });
      const result = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env,
          cwd,
          shell: spawnCommand.shell,
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
          forceKillAfter: "1 second",
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (result.code !== 0) {
        yield* Effect.logWarning("fx ask failed", {
          exitCode: result.code,
          stderr: result.stderr.slice(-2_000),
        });
        return yield* new TextGenerationError({
          operation,
          detail: fxAskFailureDetail(result.code, result.stdout),
        });
      }
      const output = decodeFxAskResult(result.stdout.trim());
      if (Option.isNone(output)) {
        return yield* new TextGenerationError({
          operation,
          detail: "fx returned unexpected output format.",
        });
      }
      const text = output.value.final_output.trim();
      if (text.length === 0) {
        return yield* new TextGenerationError({ operation, detail: "fx returned empty output." });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "fx", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.scoped,
        Effect.timeoutOption(FX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "fx request timed out." })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: isCommandMissingCause(cause)
                  ? "fx is not installed or not on PATH."
                  : "fx text generation failed.",
                cause,
              }),
        ),
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "FxTextGeneration",
    TextGenerationOperations.withoutInvestigation("fx", runFxJson),
  );
});
