import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";
import { runKokoroWorker } from "../speech/kokoro.ts";
import { runNativeSpeechWorker } from "../speech/native.ts";
import { runFrontModelWorker } from "../voice/llama.ts";

export const speechWorkerCommand = Command.make("__speech-worker", {
  mode: Argument.Literals("mode", ["discover", "model", "tts", "front"]),
  moduleUrl: Argument.String("module-url").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ mode, moduleUrl }) =>
    Effect.promise(() =>
      mode === "tts"
        ? runKokoroWorker()
        : mode === "front"
          ? runFrontModelWorker()
          : runNativeSpeechWorker(mode, moduleUrl._tag === "Some" ? moduleUrl.value : undefined),
    ),
  ),
);
