import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import type { PiSettings } from "../settings.ts";

import { makePiRpcConnection, piRecordField, piRecordString, resolvePiModelSlug } from "./rpc.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import { preparePiInferenceEnvironment, runPiVersionCommand } from "./inference.ts";
import { T3_PI_INFERENCE_EXTENSION_ENV } from "./inferenceExtensionSource.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { isPiThinkingLevel } from "./modelCapabilities.ts";
import { MINIMUM_PI_VERSION } from "./status.ts";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

// Pi's `errorMessage` is the provider's raw response text and can echo
// credentials, so only a leading HTTP status reaches the error detail.
const piTurnErrorDetail = (errorMessage: string | undefined) => {
  const status = errorMessage?.match(/^([45]\d\d)\b/)?.[1];
  return status === undefined
    ? "Pi could not generate text: the model provider reported an error."
    : `Pi could not generate text: the model provider returned HTTP ${status}.`;
};

const ISOLATED_SYSTEM_PROMPTS: Partial<
  Record<TextGenerationOperations.Operation, { readonly system: string; readonly append: string }>
> = {
  generateModelEvaluation: {
    system: "You evaluate anonymous task outcomes using the supplied rubric and evidence.",
    append: "Use only the supplied evidence. Do not identify the candidate or use tools.",
  },
  generateConversationSummary: {
    system: "You summarize the supplied conversation sources.",
    append: "Use only the supplied sources. Do not use tools.",
  },
  curateProjectMemory: {
    system: "You review the supplied project memories.",
    append: "Use only the supplied facts and evidence. Do not use tools.",
  },
  checkFactStanding: {
    system: "You classify the supplied statements.",
    append: "Use only the supplied statements. Do not use tools.",
  },
};
const PI_BLIND_ARGS = ["--no-context-files", "--no-skills", "--no-prompt-templates"] as const;

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cacheDir = "",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
  const supportsSourceOnlyGeneration =
    resolvedLaunchArgs.ok &&
    !resolvedLaunchArgs.args.some((argument) =>
      [
        "--system-prompt",
        "--append-system-prompt",
        "--prompt-template",
        "--skill",
        "--extension",
        "-e",
      ].includes(argument),
    );

  const runPiJson: TextGenerationOperations.Runner = Effect.fn("PiTextGeneration.runPiJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (thinking !== undefined && isPiThinkingLevel(thinking)) {
        const output = yield* runPiVersionCommand(piSettings, environment, cwd).pipe(
          Effect.timeoutOption(4_000),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const version =
          Option.isSome(output) && output.value.code === 0
            ? parseGenericCliVersion(`${output.value.stdout}\n${output.value.stderr}`)
            : null;
        if (version === null || compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi ${MINIMUM_PI_VERSION} or newer is required for text generation thinking options. Update Pi and try again.`,
          });
        }
      }

      if (!resolvedLaunchArgs.ok) {
        return yield* new TextGenerationError({
          operation,
          detail: resolvedLaunchArgs.message,
        });
      }
      if (operation === "generateModelEvaluation" && !supportsSourceOnlyGeneration) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Blind evaluation cannot use Pi launch arguments that add prompts, skills, or extensions. Choose a separate evaluator instance without these arguments.",
        });
      }
      const preparedEnvironment = yield* preparePiInferenceEnvironment({
        config: piSettings,
        environment,
        cacheDir,
        cwd,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: cause.detail ?? "Could not prepare Pi inference routing.",
              cause,
            }),
        ),
      );
      const launch = buildPiRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment: preparedEnvironment,
        mcpSession: undefined,
        extensionPath: undefined,
        trustedProviderExtensionPath: preparedEnvironment[T3_PI_INFERENCE_EXTENSION_ENV],
        ephemeral: true,
        shortLived: true,
        disableExtensions: true,
        // Background naming/content helpers must never mutate the workspace.
        disableTools: true,
      });
      const isolatedPrompts = ISOLATED_SYSTEM_PROMPTS[operation];
      const connection = yield* makePiRpcConnection({
        command: piSettings.binaryPath || "pi",
        args:
          isolatedPrompts !== undefined
            ? [
                ...launch.args,
                ...PI_BLIND_ARGS,
                // Explicit sources suppress discovery of global SYSTEM.md and APPEND_SYSTEM.md.
                "--system-prompt",
                isolatedPrompts.system,
                "--append-system-prompt",
                isolatedPrompts.append,
              ]
            : launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (modelSelection.model !== "default") {
        // Reject unusable custom slugs; silently using Pi's default would misreport the requested model.
        const inventory = yield* connection
          .request({ type: "get_available_models" })
          .pipe(Effect.orElseSucceed(() => undefined));
        const parsed = resolvePiModelSlug(modelSelection.model, piRecordField(inventory, "models"));
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi model '${modelSelection.model}' must use provider/model format.`,
          });
        }
        yield* connection
          .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(
            // Model discovery loads extensions that this background helper disables.
            Effect.mapError((error) =>
              error._tag === "PiRpcError" && error.operation === "set_model"
                ? new TextGenerationError({
                    operation,
                    detail:
                      `Pi rejected model '${modelSelection.model}': ${error.detail ?? "unknown error"}. ` +
                      "If the model comes from a Pi extension or package, text generation cannot use it " +
                      "because it runs Pi with --no-extensions. Pick a built-in Pi model or one defined " +
                      "in Pi's models.json.",
                    cause: error,
                  })
                : error,
            ),
          );
      }

      if (thinking !== undefined && isPiThinkingLevel(thinking)) {
        const setThinking = connection.request({ type: "set_thinking_level", level: thinking });
        // Pi rejects xhigh/max for models without a thinkingLevelMap entry; a stale saved
        // level falls back to Pi's default, but a judge must run at the level it was given.
        yield* operation === "generateModelEvaluation"
          ? setThinking.pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "Pi could not apply the selected thinking level.",
                    cause,
                  }),
              ),
            )
          : setThinking.pipe(Effect.catchTags({ PiRpcError: () => Effect.void }));
      }

      yield* connection.request({ type: "prompt", message: prompt });
      // Provider failures (bad key, rate limit, 5xx) arrive on the assistant
      // `message_end`. Keep only the latest, since Pi can retry and still answer.
      let turnError: string | undefined;
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "agent_settled") return;
          const message = event["message"];
          if (event["type"] === "message_end" && piRecordString(message, "role") === "assistant") {
            turnError =
              piRecordString(message, "stopReason") === "error"
                ? piTurnErrorDetail(piRecordString(message, "errorMessage"))
                : undefined;
          }
        }
      });
      const data = yield* connection.request({ type: "get_last_assistant_text" });
      const text =
        typeof data === "object" &&
        data !== null &&
        typeof (data as { text?: unknown }).text === "string"
          ? (data as { text: string }).text.trim()
          : "";
      if (!text) {
        return yield* new TextGenerationError(
          turnError === undefined
            ? { operation, detail: "Pi returned empty output.", kind: "empty" }
            : { operation, detail: turnError },
        );
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Pi", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "Pi request timed out." })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Pi text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner("PiTextGeneration", runPiJson, {
    supportsInvestigation: false,
    supportsBlindEvaluation: supportsSourceOnlyGeneration,
    supportsConversationSummary: supportsSourceOnlyGeneration,
  });
});
