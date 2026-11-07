import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import type { KokoroSpeaker } from "./kokoro.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as TextToSpeech from "./TextToSpeech.ts";

const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: () => Effect.succeed(true),
    installedPath: () => Effect.undefined,
    download: (file) => Effect.succeed(`/models/${file.directory}/${file.filename}`),
    remove: () => Effect.void,
  }),
);

it.effect("renders a chunk per sentence on one worker, unloaded once speech goes idle", () => {
  const loads: string[] = [];
  const spoken: string[] = [];
  let disposed = 0;
  const load = async (directory: string): Promise<KokoroSpeaker> => {
    loads.push(directory);
    return {
      speak: async (text, voice) => {
        spoken.push(`${voice}: ${text}`);
        return Float32Array.of(text.length);
      },
      dispose: async () => void (disposed += 1),
    };
  };
  return Effect.gen(function* () {
    const tts = yield* TextToSpeech.make(load);
    const first = yield* Stream.runCollect(tts.synthesize("Sure. Running the tests now."));
    expect(first.map((pcm) => [...pcm])).toEqual([[5], [22]]);
    yield* Stream.runDrain(tts.synthesize("Done.", "bm_george"));
    expect(spoken).toEqual([
      "af_heart: Sure.",
      "af_heart: Running the tests now.",
      "bm_george: Done.",
    ]);
    expect(loads).toEqual(["/models/kokoro-82m-v1.0-onnx"]);
    expect(disposed).toBe(0);
    yield* TestClock.adjust("5 minutes");
    expect(disposed).toBe(1);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* tts.hold;
        yield* TestClock.adjust("10 minutes");
        expect([loads.length, disposed]).toEqual([2, 1]);
      }),
    );
    yield* TestClock.adjust("5 minutes");
    expect(disposed).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(store, NodeServices.layer)));
});
