import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import type { PiSettings } from "../settings.ts";

import { makePiRpcConnection, parsePiModelSlug, piRecordString } from "./rpc.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

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

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson: TextGenerationOperations.Runner = Effect.fn("PiTextGeneration.runPiJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;

      const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* new TextGenerationError({
          operation,
          detail: resolvedLaunchArgs.message,
        });
      }
      const launch = buildPiRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment,
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        disableExtensions: true,
        // Background naming/content helpers must never mutate the workspace.
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: piSettings.binaryPath || "pi",
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (modelSelection.model !== "default") {
        // Reject unusable custom slugs; silently using Pi's default would misreport the requested model.
        const parsed = parsePiModelSlug(modelSelection.model);
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
        return yield* new TextGenerationError({
          operation,
          detail: turnError ?? "Pi returned empty output.",
        });
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

  return TextGenerationOperations.fromRunner(
    "PiTextGeneration",
    TextGenerationOperations.withoutInvestigation("Pi", runPiJson),
  );
});
