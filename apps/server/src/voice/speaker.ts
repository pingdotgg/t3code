import type { VoiceConversationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { splitSentences } from "../speech/sentences.ts";
import type * as TextToSpeech from "../speech/TextToSpeech.ts";
import { splitAtCursor, words, type SpokenSentence } from "./turnTaking.ts";

/** Half a second of 24 kHz audio, so a cut takes effect between frames. */
const FRAME_SAMPLES = 12_000;

export type VoiceCallOutput =
  | VoiceConversationEvent
  | { readonly type: "audio"; readonly seq: number; readonly pcm: Float32Array };

type Utterance = {
  readonly seq: number;
  readonly text: string;
  readonly sentences: SpokenSentence[];
  sent: number;
  rendered: boolean;
  played: number;
  heard: number;
};

/**
 * The voice's side of a call: utterances play in order under their own seq, and the
 * client's playback acks say what was actually heard.
 */
export const makeSpeaker = Effect.fn("VoiceSpeaker.make")(function* (input: {
  readonly send: (output: VoiceCallOutput) => Effect.Effect<void>;
  readonly tts: TextToSpeech.TextToSpeech["Service"];
  readonly voice: string | undefined;
  /** Runs whenever `busy` may have changed. */
  readonly changed: Effect.Effect<void>;
}) {
  const { send, tts, changed } = input;
  const pending = yield* Queue.unbounded<Utterance>();
  const utterances: Utterance[] = [];
  let lastSeq = 0;
  let cutSeq = 0;
  let speaking: Fiber.Fiber<void, unknown> | undefined;

  const live = () => utterances.filter((utterance) => utterance.seq > cutSeq);
  const prune = () => {
    for (let index = utterances.length - 1; index >= 0; index--) {
      const utterance = utterances[index]!;
      if (utterance.seq <= cutSeq || (utterance.rendered && utterance.played >= utterance.sent))
        utterances.splice(index, 1);
    }
  };
  const play = Effect.fn("VoiceSpeaker.play")(function* (utterance: Utterance) {
    let sentence = 0;
    yield* tts.synthesize(utterance.text, input.voice).pipe(
      Stream.runForEach((pcm) =>
        Effect.gen(function* () {
          for (let start = 0; start < pcm.length; start += FRAME_SAMPLES) {
            // A cut lands between frames, even while this fiber is mid-sentence.
            if (utterance.seq <= cutSeq) return;
            const frame = pcm.subarray(start, start + FRAME_SAMPLES);
            utterance.sent += frame.length;
            yield* send({ type: "audio", seq: utterance.seq, pcm: frame });
          }
          const spoken = utterance.sentences[sentence++];
          if (spoken) utterance.sentences[sentence - 1] = { ...spoken, end: utterance.sent };
        }),
      ),
    );
    utterance.rendered = true;
  });
  // A failed utterance is cut so the client stops waiting for its audio.
  const failed = (utterance: Utterance) => (cause: unknown) =>
    Effect.gen(function* () {
      yield* Effect.logError("voice synthesis failed", { cause });
      if (utterance.seq <= cutSeq) return;
      cutSeq = utterance.seq;
      yield* send({ type: "cut", seq: utterance.seq });
    });
  yield* Effect.forever(
    Effect.gen(function* () {
      const next = yield* Queue.take(pending);
      if (next.seq <= cutSeq) return;
      speaking = yield* play(next).pipe(Effect.catch(failed(next)), Effect.forkChild);
      yield* Fiber.await(speaking);
      speaking = undefined;
      yield* changed;
    }),
  ).pipe(Effect.forkScoped);

  return {
    /** Speaking, in the contract's sense: queued, rendering, or not yet heard to the end. */
    busy: () =>
      live().some((utterance) => !utterance.rendered || utterance.played < utterance.sent),
    speak: Effect.fn("VoiceSpeaker.speak")(function* (text: string) {
      const utterance: Utterance = {
        seq: ++lastSeq,
        text,
        sentences: splitSentences(text).map((sentence) => ({ text: sentence })),
        sent: 0,
        rendered: false,
        played: 0,
        heard: 0,
      };
      utterances.push(utterance);
      yield* send({ type: "speak", seq: utterance.seq, text, sampleRate: tts.sampleRate });
      yield* send({ type: "caption", who: "voice", committed: "", tentative: text });
      yield* Queue.offer(pending, utterance);
      yield* changed;
      return utterance.seq;
    }),
    /** Records the playback cursor and returns the words it newly passed. */
    played: Effect.fn("VoiceSpeaker.played")(function* (seq: number, sample: number) {
      const utterance = live().find((candidate) => candidate.seq === seq);
      if (!utterance || sample <= utterance.played) return [];
      // Earlier seqs finished playing once a later one plays.
      for (const earlier of live()) if (earlier.seq < seq) earlier.played = earlier.sent;
      utterance.played = Math.min(sample, utterance.sent);
      const split = splitAtCursor(utterance.sentences, utterance.played);
      const heard = words(split.played);
      const fresh = heard.slice(utterance.heard);
      if (fresh.length > 0) {
        utterance.heard = heard.length;
        yield* send({
          type: "caption",
          who: "voice",
          committed: split.played,
          tentative: split.rest,
        });
      }
      prune();
      yield* changed;
      return fresh;
    }),
    /** Stops everything queued or playing, and returns what was not heard yet. */
    cut: Effect.gen(function* () {
      const unheard = live();
      if (unheard.length === 0) return "";
      cutSeq = lastSeq;
      if (speaking) yield* Fiber.interrupt(speaking);
      yield* send({ type: "cut", seq: cutSeq });
      const rest = unheard
        .map((utterance) =>
          utterance.played > 0
            ? splitAtCursor(utterance.sentences, utterance.played).rest
            : utterance.text,
        )
        .filter(Boolean)
        .join(" ");
      prune();
      yield* changed;
      return rest;
    }).pipe(Effect.withSpan("VoiceSpeaker.cut")),
  };
});

export type Speaker = Effect.Success<ReturnType<typeof makeSpeaker>>;
