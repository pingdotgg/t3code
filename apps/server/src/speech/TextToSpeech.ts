import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcRef from "effect/RcRef";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  KOKORO_DEFAULT_VOICE,
  KOKORO_MODEL_FILES,
  KOKORO_SAMPLE_RATE,
  loadKokoroSpeaker,
  type KokoroSpeaker,
} from "./kokoro.ts";
import { splitSentences } from "./sentences.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

export class TextToSpeechError extends Schema.TaggedError<TextToSpeechError>()(
  "TextToSpeechError",
  {
    operation: Schema.Literals(["download", "load", "synthesize"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Speech synthesis failed to ${this.operation}.`;
  }
}

export class TextToSpeech extends Context.Service<
  TextToSpeech,
  {
    readonly sampleRate: number;
    /** Loads the voice now and keeps it loaded until the scope closes, as a call does. */
    readonly hold: Effect.Effect<void, TextToSpeechError, Scope.Scope>;
    /** 24 kHz mono PCM, one chunk per sentence, so playback starts on the first. */
    readonly synthesize: (
      text: string,
      voice?: string,
    ) => Stream.Stream<Float32Array, TextToSpeechError>;
  }
>()("t3/speech/TextToSpeech") {}

/** Kokoro's worker holds about 0.9 GiB, so it goes once nothing has spoken for a while. */
const IDLE_UNLOAD = "5 minutes";

export const make = Effect.fn("TextToSpeech.make")(function* (
  load: (directory: string, signal: AbortSignal) => Promise<KokoroSpeaker> = loadKokoroSpeaker,
) {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const path = yield* Path.Path;
  const acquire = Effect.fn("TextToSpeech.acquire")(function* () {
    const installed = yield* Effect.forEach(KOKORO_MODEL_FILES, (file) =>
      store.download(file),
    ).pipe(Effect.mapError((cause) => new TextToSpeechError({ operation: "download", cause })));
    // config.json sits at the model root that transformers.js reads from.
    const directory = path.dirname(installed[0]!);
    return yield* Effect.tryPromise({
      try: (signal) => load(directory, signal),
      catch: (cause) => new TextToSpeechError({ operation: "load", cause }),
    });
  });
  const speaker = yield* RcRef.make({
    acquire: Effect.acquireRelease(acquire(), (loaded) => Effect.promise(() => loaded.dispose())),
    idleTimeToLive: IDLE_UNLOAD,
  });
  const render = Effect.fn("TextToSpeech.renderSentence")(function* (
    loaded: KokoroSpeaker,
    sentence: string,
    voice: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => loaded.speak(sentence, voice),
      catch: (cause) => new TextToSpeechError({ operation: "synthesize", cause }),
    });
  });
  return TextToSpeech.of({
    sampleRate: KOKORO_SAMPLE_RATE,
    hold: RcRef.get(speaker).pipe(Effect.asVoid, Effect.withSpan("TextToSpeech.hold")),
    synthesize: (text, voice = KOKORO_DEFAULT_VOICE) =>
      Stream.unwrap(
        RcRef.get(speaker).pipe(
          Effect.map((loaded) =>
            Stream.fromIterable(splitSentences(text)).pipe(
              Stream.mapEffect((sentence) => render(loaded, sentence, voice)),
            ),
          ),
        ),
      ).pipe(Stream.withSpan("TextToSpeech.synthesize")),
  });
});

export const layer = Layer.effect(TextToSpeech, make());
