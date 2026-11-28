import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";
import { runLocalSynthesisWorker } from "../speech/localSynthesisWorker.ts";
import { runNativeSpeechWorker } from "../speech/native.ts";

export const speechWorkerCommand = Command.make("__speech-worker", {
  mode: Argument.Literals("mode", ["discover", "model", "synthesis"]),
  moduleUrl: Argument.String("module-url").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ mode, moduleUrl }) =>
    Effect.promise(() =>
      mode === "synthesis"
        ? runLocalSynthesisWorker()
        : runNativeSpeechWorker(mode, moduleUrl._tag === "Some" ? moduleUrl.value : undefined),
    ),
  ),
);
