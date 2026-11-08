import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import type { OmpSettings } from "../settings.ts";

import { makeOmpRpcConnection, parseOmpModelSlug, ompRecordString } from "./rpc.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./mcpInjection.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

const OMP_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

// Omp's `errorMessage` is the provider's raw response text and can echo
// credentials, so only a leading HTTP status reaches the error detail.
const ompTurnErrorDetail = (errorMessage: string | undefined) => {
  const status = errorMessage?.match(/^([45]\d\d)\b/)?.[1];
  return status === undefined
    ? "Omp could not generate text: the model provider reported an error."
    : `Omp could not generate text: the model provider returned HTTP ${status}.`;
};

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runOmpJson: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.runOmpJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;

      const resolvedLaunchArgs = resolveOmpLaunchArgs(ompSettings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* new TextGenerationError({
          operation,
          detail: resolvedLaunchArgs.message,
        });
      }
      const launch = buildOmpRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment,
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        shortLived: true,
        disableExtensions: true,
        // Background naming/content helpers must never mutate the workspace.
        disableTools: true,
      });
      const connection = yield* makeOmpRpcConnection({
        command: ompSettings.binaryPath || "omp",
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (modelSelection.model !== "default") {
        // Reject unusable custom slugs; silently using Omp's default would misreport the requested model.
        const parsed = parseOmpModelSlug(modelSelection.model);
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `Omp model '${modelSelection.model}' must use provider/model format.`,
          });
        }
        yield* connection
          .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(
            // Model discovery loads extensions that this background helper disables.
            Effect.mapError((error) =>
              error._tag === "OmpRpcError" && error.operation === "set_model"
                ? new TextGenerationError({
                    operation,
                    detail:
                      `Omp rejected model '${modelSelection.model}': ${error.detail ?? "unknown error"}. ` +
                      "If the model comes from a Omp extension or package, text generation cannot use it " +
                      "because it runs Omp with --no-extensions. Pick a built-in Omp model or one defined " +
                      "in Omp's models.json.",
                    cause: error,
                  })
                : error,
            ),
          );
      }

      yield* connection.request({ type: "prompt", message: prompt });
      // Provider failures (bad key, rate limit, 5xx) arrive on the assistant
      // `message_end`. Keep only the latest, since Omp can retry and still answer.
      let turnError: string | undefined;
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "session_settled") return;
          const message = event["message"];
          if (event["type"] === "message_end" && ompRecordString(message, "role") === "assistant") {
            turnError =
              ompRecordString(message, "stopReason") === "error"
                ? ompTurnErrorDetail(ompRecordString(message, "errorMessage"))
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
          detail: turnError ?? "Omp returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Omp", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(OMP_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "Omp request timed out." })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Omp text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("Omp", runOmpJson),
  );
});
