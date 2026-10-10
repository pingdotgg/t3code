/**
 * PiTextGeneration — commit messages, PR content, branch names, and thread
 * titles generated through an ephemeral `pi --mode rpc --no-session` process.
 * No session file is written; the user's Pi configuration (default model,
 * auth, custom providers) still applies.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import type { PiSettings } from "../settings.ts";

import { makePiRpcConnection, parsePiModelSlug } from "./rpc.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
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
        // No user is present to answer a text-generation extension dialog.
        disableExtensions: true,
        // Background naming/content helpers must never mutate the workspace.
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: piSettings.binaryPath || "pi",
        // Extensions and tools are disabled because no user is present to
        // answer a dialog and background text generation is read-only. User
        // model config and auth still apply.
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (modelSelection.model !== "default") {
        // `customModels` accepts arbitrary strings, so an unusable slug is
        // rejected rather than skipped: running Pi's default model here would
        // report success for a model the caller never asked for.
        const parsed = parsePiModelSlug(modelSelection.model);
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi model '${modelSelection.model}' must use provider/model format.`,
          });
        }
        yield* connection.request({
          type: "set_model",
          provider: parsed.provider,
          modelId: parsed.modelId,
        });
      }

      yield* connection.request({ type: "prompt", message: prompt });
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "agent_settled") return;
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
          detail: "Pi returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Pi", text);
    }).pipe(
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
  };

  return TextGenerationOperations.fromRunner("PiTextGeneration", runPiJson);
});
