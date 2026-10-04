import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";
import { runNativeSpeechWorker } from "../speech/native.ts";

export const speechWorkerCommand = Command.make("__speech-worker", {
  mode: Argument.Literals("mode", ["discover", "model"]),
  moduleUrl: Argument.String("module-url").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ mode, moduleUrl }) =>
    Effect.promise(() =>
      runNativeSpeechWorker(mode, moduleUrl._tag === "Some" ? moduleUrl.value : undefined),
    ),
  ),
);
