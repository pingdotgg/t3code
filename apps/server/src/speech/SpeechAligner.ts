// @effect-diagnostics nodeBuiltinImport:off - the aligner's thread count comes from the host's CPU count.
import * as NodeOS from "node:os";
import type { AudioCppAlignedWord, AudioCppAudio } from "@t3tools/audio-cpp";
import type { SpeechSynthesisWord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import { loadLocalAlignmentModel, type SpeechSpan } from "./localSynthesisWorker.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import { estimateWords, textWords } from "./wordAlignment.ts";

// Players keep lame's encoder delay at the start of each MP3 stream the PCM becomes.
const MP3_ENCODER_DELAY_SAMPLES = 1105;
const IDLE_UNLOAD = "2 minutes";
// A star before every word lets the alignment pass over speech the text does not spell, such as
// "twenty five" for "25". The text is given already romanized, as ASCII letters.
const ALIGNMENT_OPTIONS = { text_normalization: "pre_romanized", star_frequency: "segment" };
// Latin letters the aligner's alphabet writes as other letters; the rest only lose their marks.
const LATIN_SPELLINGS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
  ŋ: "ng",
  ħ: "h",
};

export type Aligner = {
  readonly align: (request: {
    readonly audio: AudioCppAudio;
    readonly text: string;
    readonly language: string;
    readonly options?: Readonly<Record<string, string>>;
  }) => Promise<ReadonlyArray<AudioCppAlignedWord>>;
  readonly dispose: () => Promise<void>;
};

/** Mono 16-bit PCM at `rate`, starting `startSeconds` into the reply's MP3, speaking `span`. */
export type AlignmentAudio = {
  readonly pcm: Int16Array;
  readonly rate: number;
  readonly startSeconds: number;
  readonly span: SpeechSpan;
};

/** Times one reply's words from its audio, a stretch of text at a time as the audio arrives. */
export type AlignmentSession = {
  /** Returns the words of the stretch before `audio`'s, once its audio is complete. */
  readonly push: (audio: AlignmentAudio) => Effect.Effect<ReadonlyArray<SpeechSynthesisWord>>;
  /** Times the words of the last stretch. */
  readonly finish: Effect.Effect<ReadonlyArray<SpeechSynthesisWord>>;
};

export class SpeechAligner extends Context.Service<
  SpeechAligner,
  {
    /** Downloads the aligner, and the runtime it runs on, in the background when missing. */
    readonly prepare: Effect.Effect<void>;
    /** `undefined` until the aligner is installed. */
    readonly session: (
      text: string,
      language: string,
    ) => Effect.Effect<AlignmentSession | undefined>;
  }
>()("t3/speech/SpeechAligner") {}

/**
 * A word as the aligner spells it: lowercase ASCII letters and apostrophes, or undefined when it
 * has letters outside the Latin script. Digits and symbols drop out, which can leave nothing.
 */
export function alignerSpelling(word: string) {
  let spelled = "";
  for (const character of word.toLowerCase().normalize("NFKD")) {
    if (/[a-z']/.test(character)) spelled += character;
    else if (LATIN_SPELLINGS[character]) spelled += LATIN_SPELLINGS[character];
    else if (/\p{M}/u.test(character)) continue;
    else if (/\p{L}/u.test(character)) return undefined;
  }
  return spelled;
}

/**
 * The words of `text` in `span`, timed from `aligned`: the aligner's times for the words it
 * spelled, given in order, and the rest spread between their timed neighbors.
 */
function timeSpanWords(
  text: string,
  span: SpeechSpan,
  spelled: ReadonlyArray<boolean>,
  aligned: ReadonlyArray<{ readonly startSeconds: number; readonly endSeconds: number }>,
  audio: { readonly startSeconds: number; readonly endSeconds: number },
): SpeechSynthesisWord[] {
  const words = textWords(text).filter((word) => word.start >= span.start && word.end <= span.end);
  const out: SpeechSynthesisWord[] = [];
  let next = 0;
  let untimed: Array<{ readonly start: number; readonly end: number }> = [];
  let previousEnd = audio.startSeconds;
  const spread = (until: number) => {
    if (untimed.length) out.push(...estimateWords(text, untimed, previousEnd, until));
    untimed = [];
  };
  words.forEach((word, index) => {
    const timed = spelled[index] ? aligned[next++] : undefined;
    if (!timed) {
      untimed.push(word);
      return;
    }
    const startSeconds = audio.startSeconds + timed.startSeconds;
    spread(startSeconds);
    const endSeconds = audio.startSeconds + timed.endSeconds;
    out.push({ ...word, startSeconds, endSeconds });
    previousEnd = endSeconds;
  });
  spread(audio.endSeconds);
  return out;
}

export const make = Effect.fn("SpeechAligner.make")(function* (
  loadAligner: (
    options: { readonly libraryPath: string; readonly backend: string; readonly modelPath: string },
    signal: AbortSignal,
  ) => Promise<Aligner>,
) {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const local = yield* LocalSpeechSynthesis.LocalSpeechSynthesis;
  const scope = yield* Effect.scope;
  // @effect-diagnostics-next-line abortControllerInEffect:off - The loaded worker must also stop on service shutdown.
  const lifetime = new AbortController();
  const permit = yield* Semaphore.make(1);
  let downloading = false;
  let loaded: Aligner | undefined;
  let unload: Fiber.Fiber<void> | undefined;

  const dispose = Effect.promise(async () => {
    const current = loaded;
    loaded = undefined;
    await current?.dispose();
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => lifetime.abort()).pipe(Effect.andThen(dispose)),
  );

  const prepare = Effect.suspend(() => {
    if (downloading) return Effect.void;
    downloading = true;
    return local.installRuntime.pipe(
      Effect.andThen(store.download(SPEECH_ALIGNER_FILE)),
      Effect.tapError((error) => Effect.logWarning("Word timing model download failed.", error)),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          downloading = false;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  }).pipe(Effect.withSpan("SpeechAligner.prepare"));

  // One aligner stays loaded until it has been idle for a while; alignments run one at a time.
  const align = (
    paths: { readonly libraryPath: string; readonly backend: string; readonly modelPath: string },
    request: Parameters<Aligner["align"]>[0],
  ) =>
    Semaphore.withPermit(
      permit,
      Effect.gen(function* () {
        if (unload) yield* Fiber.interrupt(unload);
        loaded ??= yield* Effect.promise(() => loadAligner(paths, lifetime.signal));
        const aligner = loaded;
        // A failed alignment may have taken the worker with it; the next one starts a fresh worker.
        const words = yield* Effect.promise(() => aligner.align(request)).pipe(
          Effect.onError(() => dispose),
        );
        unload = yield* Effect.sleep(IDLE_UNLOAD).pipe(
          Effect.andThen(Semaphore.withPermit(permit, dispose)),
          Effect.forkIn(scope),
        );
        return words;
      }),
    );

  const session = Effect.fn("SpeechAligner.session")(function* (text: string, language: string) {
    const library = yield* local.runtimeLibrary;
    const modelPath = yield* store.installedPath(SPEECH_ALIGNER_FILE);
    if (!library || !modelPath) {
      yield* prepare;
      return undefined;
    }
    const paths = { libraryPath: library.path, backend: library.backend, modelPath };
    const code = language.toLowerCase().split("-")[0]!;
    // The romanized text carries no language of its own; the code is only recorded.
    const alignmentLanguage = code === "auto" ? "und" : code;
    let pending: AlignmentAudio[] = [];

    const alignSpan = Effect.fnUntraced(function* (parts: ReadonlyArray<AlignmentAudio>) {
      const [first] = parts;
      if (!first) return [];
      const span = first.span;
      const rate = first.rate;
      const length = parts.reduce((total, part) => total + part.pcm.length, 0);
      const samples = new Float32Array(length);
      let offset = 0;
      for (const part of parts) {
        for (let index = 0; index < part.pcm.length; index++)
          samples[offset + index] = part.pcm[index]! / 0x8000;
        offset += part.pcm.length;
      }
      const startSeconds = first.startSeconds + MP3_ENCODER_DELAY_SAMPLES / rate;
      const bounds = { startSeconds, endSeconds: startSeconds + length / rate };
      const words = textWords(text).filter(
        (word) => word.start >= span.start && word.end <= span.end,
      );
      const spellings = words.map((word) => alignerSpelling(text.slice(word.start, word.end)));
      const spelled = spellings.map((spelling) => !!spelling);
      const transcript = spellings.filter((spelling) => !!spelling).join(" ");
      const aligned = transcript
        ? yield* align(paths, {
            audio: { samples, sampleRate: rate, channels: 1 },
            text: transcript,
            language: alignmentLanguage,
            options: ALIGNMENT_OPTIONS,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Word timing failed.", cause).pipe(Effect.as([])),
            ),
          )
        : [];
      // Without a time for every word it spelled, the words are spread over the audio instead.
      const complete = aligned.length === spelled.filter(Boolean).length;
      return timeSpanWords(
        text,
        span,
        complete ? spelled : spelled.map(() => false),
        complete ? aligned : [],
        bounds,
      );
    });

    const push = Effect.fnUntraced(function* (audio: AlignmentAudio) {
      const current = pending[0];
      const done =
        current && (current.span.start !== audio.span.start || current.span.end !== audio.span.end)
          ? pending
          : undefined;
      if (done) pending = [];
      pending.push(audio);
      return done ? yield* alignSpan(done) : [];
    });

    const finish = Effect.suspend(() => {
      const done = pending;
      pending = [];
      return alignSpan(done);
    });

    return { push, finish } satisfies AlignmentSession;
  });

  return SpeechAligner.of({ prepare, session });
});

const { SPEECH_ALIGNER_FILE } = LocalSpeechSynthesis;

export const layer = Layer.effect(
  SpeechAligner,
  make((options, signal) =>
    loadLocalAlignmentModel({
      ...options,
      threads: Math.max(1, Math.min(8, NodeOS.availableParallelism() - 1)),
      signal,
    }),
  ),
);
