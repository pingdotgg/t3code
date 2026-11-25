import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { openOmpRpc, record, string } from "./rpc.ts";

export const makeOmpTextGeneration = Effect.fn("OmpTextGeneration.make")(function* (options: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly enabled: boolean;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const run: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.run")(
    function* (request) {
      const failure = (detail: string) =>
        new TextGenerationError({ operation: request.operation, detail });
      if (!options.enabled) return yield* failure("Oh My Pi is disabled.");
      const cwd = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-omp-text-" })
        .pipe(
          Effect.mapError(() =>
            failure("Could not start an isolated Oh My Pi text generation session."),
          ),
        );
      const rpc = yield* openOmpRpc({
        ...options,
        cwd,
        environment: { ...options.environment, PI_AUTO_QA: "0" },
        args: [
          "--mode",
          "rpc",
          "--approval-mode",
          "always-ask",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--offline",
        ],
      }).pipe(Effect.mapError(() => failure("Could not open Oh My Pi for text generation.")));
      const selection = request.modelSelection;
      if (selection.model !== "default") {
        const separator = selection.model.indexOf("/");
        if (separator < 1 || separator === selection.model.length - 1) {
          return yield* failure("Oh My Pi model IDs must use provider/model format.");
        }
        yield* rpc
          .request({
            type: "set_model",
            provider: selection.model.slice(0, separator),
            modelId: selection.model.slice(separator + 1),
          })
          .pipe(Effect.mapError(() => failure("Oh My Pi could not select the requested model.")));
      }
      const thinking = getModelSelectionStringOptionValue(selection, "thinking");
      if (thinking !== undefined) {
        yield* rpc.request({ type: "set_thinking_level", level: thinking }).pipe(Effect.ignore);
      }
      const promptId = "t3-text-generation";
      const result = yield* rpc.request({ type: "prompt", message: request.prompt }, promptId).pipe(
        Effect.andThen(
          rpc.events.pipe(
            Stream.filter((event) => event.type === "prompt_result" && event.id === promptId),
            Stream.runHead,
          ),
        ),
        Effect.mapError(() => failure("Oh My Pi could not complete the text generation request.")),
      );
      if (
        Option.isNone(result) ||
        result.value.status !== "completed" ||
        result.value.agentInvoked !== true
      ) {
        return yield* failure("The Oh My Pi model did not finish generating text.");
      }
      const data = yield* rpc
        .request({ type: "get_last_assistant_text" })
        .pipe(Effect.mapError(() => failure("Could not read the generated Oh My Pi text.")));
      const text = string(record(data).text)?.trim();
      if (!text) return yield* failure("Oh My Pi returned empty output.");
      return yield* TextGenerationOperations.decodeJsonReply(request, "Oh My Pi", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOrElse({
          duration: "3 minutes",
          orElse: () =>
            new TextGenerationError({
              operation: request.operation,
              detail: "Oh My Pi text generation timed out.",
            }),
        }),
      ),
  );
  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("Oh My Pi", run),
  );
});
