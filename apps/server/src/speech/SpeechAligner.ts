import type { SpeechSynthesisWord, SpeechWordAlignment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { getSpeechModel, type SpeechModel } from "./model.ts";
import { loadNativeSpeechModel } from "./native.ts";
import { isSpeechPlatformSupported } from "./platform.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import { estimateWords, matchHeardWords, textWords, type HeardWord } from "./wordAlignment.ts";

// `lag` is how much later than the spoken word each model places its start, measured against
// Kokoro's own word timings; both reach the right word over 80% of the time.
const ALIGNERS = {
  english: { id: "handy-computer/parakeet-tdt_ctc-110m-gguf", lag: 0.125 },
  multilingual: { id: "handy-computer/parakeet-tdt-0.6b-v3-gguf", lag: 0.035 },
} as const satisfies Record<SpeechWordAlignment, { readonly id: string; readonly lag: number }>;
const RATE = 16_000;
// Later windows are long enough for context; the first is short so highlighting starts early.
const WINDOW_SECONDS = 20;
const FIRST_WINDOW_SECONDS = 6;
// Players keep lame's encoder delay at the start of each MP3 stream these PCM chunks become.
const MP3_ENCODER_DELAY_SAMPLES = 1105;
// Share of heard characters the text accounts for: real readings measured 0.67 to 1, speech
// unrelated to the text 0.3. Judged over the reply so far, as one window of spelled-out
// numbers can fall below it.
const MIN_MATCHED_SHARE = 0.5;
const MIN_JUDGED_CHARACTERS = 100;
// The English model hears other languages as English with confidence, so text left on `auto`
// must read as English: these words make up several percent of nearly any English reply.
const ENGLISH_FUNCTION_WORDS = new Set([
  "the",
  "and",
  "to",
  "of",
  "is",
  "in",
  "it",
  "that",
  "for",
  "you",
  "this",
  "with",
  "on",
  "be",
  "are",
  "was",
  "not",
  "but",
]);
const MIN_ENGLISH_FUNCTION_SHARE = 0.05;
const IDLE_UNLOAD = "2 minutes";
const SCRIPTS_WITHOUT_TIMINGS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export type Transcriber = {
  readonly align: (pcm: Float32Array, language?: string) => Promise<ReadonlyArray<HeardWord>>;
  readonly dispose: () => Promise<void>;
};

/** Times one reply's words from its audio, as the audio is produced. */
export type AlignmentSession = {
  /** Mono 16-bit PCM at `rate`, starting `startSeconds` into the reply's MP3. */
  readonly push: (
    pcm: Int16Array,
    rate: number,
    startSeconds: number,
  ) => Effect.Effect<ReadonlyArray<SpeechSynthesisWord>>;
  /** Times the words still untimed, the last of them ending at `endSeconds`. */
  readonly finish: (endSeconds: number) => Effect.Effect<ReadonlyArray<SpeechSynthesisWord>>;
};

export class SpeechAligner extends Context.Service<
  SpeechAligner,
  {
    /** Downloads the model in the background when it is missing. */
    readonly prepare: (alignment: SpeechWordAlignment) => Effect.Effect<void>;
    /** `undefined` when the model is not installed yet or cannot hear the text's language. */
    readonly session: (
      text: string,
      language: string,
      alignment: SpeechWordAlignment,
    ) => Effect.Effect<AlignmentSession | undefined>;
  }
>()("t3/speech/SpeechAligner") {}

/** Linear resampling to 16 kHz floats, which speech recognition takes. */
function toRecognitionRate(pcm: Int16Array, rate: number) {
  const length = Math.floor((pcm.length * RATE) / rate);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const position = (index * rate) / RATE;
    const before = Math.floor(position);
    const after = Math.min(before + 1, pcm.length - 1);
    const mix = position - before;
    samples[index] = ((pcm[before] ?? 0) * (1 - mix) + (pcm[after] ?? 0) * mix) / 0x8000;
  }
  return samples;
}

/** The quietest 100 ms between `from` and `to` samples, so a window rarely splits a word. */
function quietestCut(samples: Float32Array, from: number, to: number) {
  const step = RATE / 10;
  let best = to;
  let bestEnergy = Infinity;
  for (let start = from; start + step <= to; start += step / 2) {
    let energy = 0;
    for (let index = start; index < start + step; index++) energy += samples[index]! ** 2;
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start + step / 2;
    }
  }
  return Math.floor(best);
}

function readsAsEnglish(text: string) {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 12) return true;
  const common = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
  return common / words.length >= MIN_ENGLISH_FUNCTION_SHARE;
}

function supportsLanguage(
  model: SpeechModel,
  alignment: SpeechWordAlignment,
  language: string,
  text: string,
) {
  const code = language.toLowerCase().split("-")[0]!;
  if (alignment === "english") return code === "en" || (code === "auto" && readsAsEnglish(text));
  return code === "auto" || model.languages.includes(code);
}

export const make = Effect.fn("SpeechAligner.make")(function* (
  loadTranscriber: (path: string, signal: AbortSignal) => Promise<Transcriber>,
) {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
  const supported = isSpeechPlatformSupported(platform, architecture, libc);
  const scope = yield* Effect.scope;
  // @effect-diagnostics-next-line abortControllerInEffect:off - The loaded worker must also stop on service shutdown.
  const lifetime = new AbortController();
  const permit = yield* Semaphore.make(1);
  const downloading = new Set<SpeechWordAlignment>();
  let loaded: { readonly alignment: SpeechWordAlignment; readonly model: Transcriber } | undefined;
  let unload: Fiber.Fiber<void> | undefined;

  const dispose = Effect.promise(async () => {
    const current = loaded;
    loaded = undefined;
    await current?.model.dispose();
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => lifetime.abort()).pipe(Effect.andThen(dispose)),
  );

  const definition = (alignment: SpeechWordAlignment) => getSpeechModel(ALIGNERS[alignment].id)!;

  const prepare = Effect.fn("SpeechAligner.prepare")(function* (alignment: SpeechWordAlignment) {
    const model = definition(alignment);
    if (!supported || downloading.has(alignment) || (yield* store.isReady(model))) return;
    downloading.add(alignment);
    yield* store.download(model).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Word timing model download failed.", { model: model.id, error }),
      ),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => downloading.delete(alignment))),
      Effect.forkIn(scope),
    );
  });

  // One model stays loaded, on the CPU, until it has been idle for a while.
  const transcribe = (
    alignment: SpeechWordAlignment,
    path: string,
    pcm: Float32Array,
    language?: string,
  ) =>
    Semaphore.withPermit(
      permit,
      Effect.gen(function* () {
        if (unload) yield* Fiber.interrupt(unload);
        if (loaded?.alignment !== alignment) {
          yield* dispose;
          const model = yield* Effect.promise(() => loadTranscriber(path, lifetime.signal));
          loaded = { alignment, model };
        }
        const model = loaded!.model;
        const heard = yield* Effect.promise(() => model.align(pcm, language));
        unload = yield* Effect.sleep(IDLE_UNLOAD).pipe(
          Effect.andThen(Semaphore.withPermit(permit, dispose)),
          Effect.forkIn(scope),
        );
        return heard;
      }),
    );

  const session = Effect.fn("SpeechAligner.session")(function* (
    text: string,
    language: string,
    alignment: SpeechWordAlignment,
  ) {
    const model = definition(alignment);
    if (
      !supported ||
      SCRIPTS_WITHOUT_TIMINGS.test(text) ||
      !supportsLanguage(model, alignment, language, text)
    )
      return undefined;
    const path = yield* store.installedPath(model);
    if (!path) {
      yield* prepare(alignment);
      return undefined;
    }
    const code = language.toLowerCase().split("-")[0]!;
    const recognitionLanguage = alignment === "multilingual" && code !== "auto" ? code : undefined;
    const lag = ALIGNERS[alignment].lag;
    const words = textWords(text);
    // Words before `next` are sent; `anchor` is the last heard word, sent with the next batch.
    let next = 0;
    let anchor: { readonly index: number; readonly seconds: number } | undefined;
    let abandoned = false;
    let matchedCharacters = 0;
    let heardCharacters = 0;
    let buffer: Float32Array[] = [];
    let buffered = 0;
    let bufferStart = 0;

    const spread = (from: number, to: number, startSeconds: number, endSeconds: number) =>
      estimateWords(text, words.slice(from, to), startSeconds, endSeconds);

    const alignWindow = Effect.fnUntraced(function* (samples: Float32Array, startSeconds: number) {
      if (abandoned || next >= words.length) return [];
      const heard = (yield* transcribe(alignment, path, samples, recognitionLanguage).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Word timing failed.", cause).pipe(Effect.as(undefined)),
        ),
      ))?.map((word) => ({
        text: word.text,
        startSeconds: startSeconds + word.startSeconds - lag,
        endSeconds: startSeconds + word.endSeconds - lag,
      }));
      if (!heard) {
        abandoned = true;
        return [];
      }
      const result = matchHeardWords(text, words, anchor?.index ?? next, heard);
      matchedCharacters += result.matched;
      heardCharacters += result.heard;
      if (
        heardCharacters >= MIN_JUDGED_CHARACTERS &&
        matchedCharacters < heardCharacters * MIN_MATCHED_SHARE
      ) {
        abandoned = true;
        return [];
      }
      const starts = result.starts;
      const matched = [...starts].sort(([a], [b]) => a - b);
      const out: SpeechSynthesisWord[] = [];
      for (const [index, seconds] of matched) {
        if (index < next || (anchor && (index <= anchor.index || seconds <= anchor.seconds)))
          continue;
        if (anchor) out.push(...spread(anchor.index, index, anchor.seconds, seconds));
        else if (index > next) out.push(...spread(next, index, startSeconds, seconds));
        anchor = { index, seconds: Math.max(seconds, 0) };
        next = index;
      }
      return out;
    });

    const flush = Effect.fnUntraced(function* (upTo: number) {
      const samples = new Float32Array(buffered);
      let offset = 0;
      for (const chunk of buffer) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      const start = bufferStart;
      buffer = [samples.subarray(upTo)];
      buffered = samples.length - upTo;
      bufferStart = start + upTo / RATE;
      return yield* alignWindow(samples.subarray(0, upTo), start);
    });

    const push = Effect.fnUntraced(function* (pcm: Int16Array, rate: number, startSeconds: number) {
      if (abandoned) return [];
      const samples = toRecognitionRate(pcm, rate);
      const start = startSeconds + MP3_ENCODER_DELAY_SAMPLES / rate;
      const out: SpeechSynthesisWord[] = [];
      // A gap, such as the next cloud piece, closes the window before it.
      if (buffered && Math.abs(start - (bufferStart + buffered / RATE)) > 0.05)
        out.push(...(yield* flush(buffered)));
      if (!buffered) bufferStart = start;
      buffer.push(samples);
      buffered += samples.length;
      for (
        let window = anchor ? WINDOW_SECONDS : FIRST_WINDOW_SECONDS;
        !abandoned && buffered >= window * RATE;
        window = anchor ? WINDOW_SECONDS : FIRST_WINDOW_SECONDS
      ) {
        const merged = new Float32Array(buffered);
        let offset = 0;
        for (const chunk of buffer) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        buffer = [merged];
        out.push(...(yield* flush(quietestCut(merged, (window * 3 * RATE) / 4, window * RATE))));
      }
      return out;
    });

    const finish = Effect.fnUntraced(function* (endSeconds: number) {
      const out: SpeechSynthesisWord[] = buffered ? [...(yield* flush(buffered))] : [];
      if (!anchor) return out;
      out.push(
        ...spread(anchor.index, words.length, anchor.seconds, Math.max(endSeconds, anchor.seconds)),
      );
      next = words.length;
      return out;
    });

    return { push, finish } satisfies AlignmentSession;
  });

  return SpeechAligner.of({ prepare, session });
});

export const layer = Layer.effect(
  SpeechAligner,
  make(async (path, signal) => {
    const model = await loadNativeSpeechModel(path, signal, undefined, "cpu");
    return { align: model.align, dispose: model.dispose };
  }),
);
