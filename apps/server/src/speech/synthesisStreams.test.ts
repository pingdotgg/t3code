import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import { SpeechSynthesisError, type SpeechSynthesisRequest } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as SpeechAligner from "./SpeechAligner.ts";
import * as SpeechSynthesisStreams from "./synthesisStreams.ts";

const request: SpeechSynthesisRequest = {
  text: "Read this reply.",
  model: "",
  voice: "",
  speed: 1,
  language: "en",
};

const withSource = (
  source: Stream.Stream<CloudSpeech.SpeechSynthesisPart, SpeechSynthesisError>,
  aligner: Partial<SpeechAligner.SpeechAligner["Service"]> = {},
) =>
  SpeechSynthesisStreams.layer.pipe(
    Layer.provide(Layer.mock(CloudSpeech.CloudSpeech)({ stream: () => source })),
    Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({})),
    Layer.provide(Layer.mock(SpeechAligner.SpeechAligner)(aligner)),
    Layer.provide(SecureRandom.layerWebCrypto),
  );

const audio = (stream: Stream.Stream<Uint8Array> | undefined) =>
  Stream.runCollect(stream ?? Stream.die("expired")).pipe(
    Effect.map((chunks) => chunks.flatMap((chunk) => [...chunk])),
  );

it.effect("hands every reader the audio from its start while synthesis continues", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<Uint8Array, SpeechSynthesisError | Cause.Done>();
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offer(source, Uint8Array.of(1));
      const token = yield* streams.start("xai", request);
      const live = yield* Effect.forkChild(audio(yield* streams.read(token)));
      yield* Queue.offer(source, Uint8Array.of(2));
      yield* Queue.end(source);
      expect(yield* Fiber.join(live)).toEqual([1, 2]);
      expect(yield* audio(yield* streams.read(token))).toEqual([1, 2]);
      expect(yield* streams.read("unknown")).toBeUndefined();
    }).pipe(Effect.provide(withSource(Stream.fromQueue(source))));
  }),
);

it.effect("opens the audio at a time for players that cannot seek it", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<Uint8Array, SpeechSynthesisError | Cause.Done>();
    // MPEG-1 Layer III frames at 64 kbps and 44.1 kHz, each marked with its index.
    const frameSeconds = 1152 / 44100;
    const frame = (marker: number) =>
      Uint8Array.from({ length: 208 }, (_, index) =>
        index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : index === 3 ? marker : 0,
      );
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offerAll(source, [frame(0), frame(1), frame(2)]);
      yield* Queue.end(source);
      const token = yield* streams.start("xai", request);
      yield* audio(yield* streams.read(token));
      // Within the second frame, which is where the audio opens, each frame sent once.
      expect(yield* audio(yield* streams.read(token, frameSeconds * 1.5))).toEqual(
        [1, 2].flatMap((marker) => [...frame(marker)]),
      );
      // Audio not made yet has no place to open at.
      expect(yield* streams.read(token, frameSeconds * 10)).toBeUndefined();
    }).pipe(Effect.provide(withSource(Stream.fromQueue(source))));
  }),
);

it.effect("answers word timings as they arrive and the audio length once synthesis ends", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<
      CloudSpeech.SpeechSynthesisPart,
      SpeechSynthesisError | Cause.Done
    >();
    // One MPEG-1 Layer III frame at 64 kbps and 44.1 kHz.
    const frame = Uint8Array.from({ length: 208 }, (_, index) =>
      index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
    );
    const word = (start: number) => ({ start, end: start + 4, startSeconds: start, endSeconds: 1 });
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offerAll(source, [{ words: [word(0)] }, frame]);
      const token = yield* streams.start("elevenlabs", request);
      expect(yield* streams.timings(token, 0)).toEqual({ words: [word(0)], done: false });
      const waiting = yield* Effect.forkChild(streams.timings(token, 1));
      yield* Queue.offer(source, { words: [word(5)] });
      expect(yield* Fiber.join(waiting)).toEqual({ words: [word(5)], done: false });
      yield* Queue.end(source);
      expect(yield* streams.timings(token, 2)).toEqual({
        words: [],
        done: true,
        durationSeconds: 1152 / 44100,
      });
      expect(yield* streams.timings("unknown", 0)).toEqual({ words: [], done: true });
    }).pipe(Effect.provide(withSource(Stream.fromQueue(source))));
  }),
);

it.effect("times PCM-only audio with the aligner and ends timings once it has finished", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<
      CloudSpeech.SpeechSynthesisPart,
      SpeechSynthesisError | Cause.Done
    >();
    const frame = Uint8Array.from({ length: 208 }, (_, index) =>
      index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
    );
    const word = (start: number) => ({ start, end: start + 4, startSeconds: start, endSeconds: 1 });
    const finishing = yield* Deferred.make<void>();
    const pushed: SpeechAligner.AlignmentAudio[] = [];
    const session = vi.fn(() =>
      Effect.succeed({
        push: (part: SpeechAligner.AlignmentAudio) =>
          Effect.sync(() => {
            pushed.push(part);
            return [word(0)];
          }),
        finish: Deferred.await(finishing).pipe(Effect.as([word(5)])),
      }),
    );
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      const part = {
        pcm: new Int16Array(4),
        rate: 24_000,
        startSeconds: 0.5,
        span: { start: 0, end: request.text.length },
      };
      yield* Queue.offerAll(source, [part, frame]);
      const token = yield* streams.start("xai", request);
      expect(yield* streams.timings(token, 0)).toEqual({ words: [word(0)], done: false });
      expect(session).toHaveBeenCalledWith(request.text, "en");
      expect(pushed).toEqual([part]);
      yield* Queue.end(source);
      // Synthesis has ended, but the last words are still being timed.
      const waiting = yield* Effect.forkChild(streams.timings(token, 1));
      yield* Deferred.succeed(finishing, undefined);
      expect(yield* Fiber.join(waiting)).toEqual({ words: [word(5)], done: false });
      expect(yield* streams.timings(token, 2)).toEqual({
        words: [],
        done: true,
        durationSeconds: 1152 / 44100,
      });
      expect(yield* audio(yield* streams.read(token))).toEqual([...frame]);
    }).pipe(Effect.provide(withSource(Stream.fromQueue(source), { session })));
  }),
);

it.effect("starts audio picked up mid-sentence at its word, keeping the lead-in for context", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<
      CloudSpeech.SpeechSynthesisPart,
      SpeechSynthesisError | Cause.Done
    >();
    // MPEG-1 Layer III frames at 64 kbps and 44.1 kHz, each marked with its index.
    const frameSeconds = 1152 / 44100;
    const frame = (marker: number) =>
      Uint8Array.from({ length: 208 }, (_, index) =>
        index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : index === 3 ? marker : 0,
      );
    const frames = [0, 1, 2, 3].map(frame);
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      // "Read this reply." picked up at "this".
      yield* Queue.offerAll(source, [
        { words: [{ start: 0, end: 4, startSeconds: 0, endSeconds: 0.05 }] },
        ...frames,
        {
          words: [
            { start: 5, end: 9, startSeconds: 0.04, endSeconds: 0.12 },
            { start: 10, end: 16, startSeconds: 0.12, endSeconds: 0.2 },
          ],
        },
      ]);
      const token = yield* streams.start("elevenlabs", { ...request, from: 5 });
      yield* Queue.end(source);
      // The frame the word starts in is the second, so audio starts there.
      expect(yield* audio(yield* streams.read(token))).toEqual(
        frames.slice(1).flatMap((bytes) => [...bytes]),
      );
      const cut = frameSeconds;
      const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
      expect(yield* streams.timings(token, 0)).toEqual({
        words: [
          { start: 5, end: 9, startSeconds: round(0.04 - cut), endSeconds: round(0.12 - cut) },
          { start: 10, end: 16, startSeconds: round(0.12 - cut), endSeconds: round(0.2 - cut) },
        ],
        done: true,
        durationSeconds: 3 * frameSeconds,
      });
    }).pipe(Effect.provide(withSource(Stream.fromQueue(source))));
  }),
);

it.effect("reports the loudness of PCM audio on the MP3's clock, shifted with a lead-in", () =>
  Effect.gen(function* () {
    const rate = 15_000;
    // A tenth of a second of silence, then a tenth at full scale, starting one second in.
    const pcm = Int16Array.from({ length: 3_000 }, (_, index) =>
      index < 1_500 ? 0 : index % 2 ? 0x7fff : -0x7fff,
    );
    const frame = Uint8Array.from({ length: 208 }, (_, index) =>
      index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
    );
    const part = { pcm, rate, startSeconds: 1, span: { start: 0, end: request.text.length } };
    const delay = 1105 / rate;
    const reading = (from?: number) =>
      Effect.gen(function* () {
        const source = yield* Queue.unbounded<
          CloudSpeech.SpeechSynthesisPart,
          SpeechSynthesisError | Cause.Done
        >();
        // "this" is timed at the start of the second frame, so a lead-in is cut there.
        const session = () =>
          Effect.succeed({
            push: () => Effect.succeed([]),
            finish: Effect.succeed([
              { start: 5, end: 9, startSeconds: 1152 / 44100, endSeconds: 1 },
            ]),
          });
        return yield* Effect.gen(function* () {
          const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
          yield* Queue.offerAll(source, [part, frame, frame]);
          yield* Queue.end(source);
          const token = yield* streams.start("xai", {
            ...request,
            ...(from === undefined ? {} : { from }),
          });
          yield* Stream.runDrain((yield* streams.read(token))!);
          // Word timings alone answer without levels; asking for levels after one skips it.
          expect((yield* streams.timings(token, 0)).levels).toBeUndefined();
          const all = (yield* streams.timings(token, 0, 0)).levels!;
          expect((yield* streams.timings(token, 0, 1)).levels).toEqual(all.slice(1));
          return all;
        }).pipe(Effect.provide(withSource(Stream.fromQueue(source), { session })));
      });
    const levels = yield* reading();
    expect(levels.map((level) => level.level)).toEqual([0, 0, 1, 1]);
    expect(levels[0]!.seconds).toBeCloseTo(1 + delay + 0.025, 3);
    // From "this", the audio starts at its frame and the levels before it are dropped.
    const cut = 1152 / 44100;
    const shifted = yield* reading(5);
    expect(shifted.map((level) => level.seconds)).toEqual(
      levels.map((level) => Math.round((level.seconds - cut) * 1000) / 1000),
    );
  }),
);

it.effect("plays the lead-in at once when no model can time the word picked", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<
      CloudSpeech.SpeechSynthesisPart,
      SpeechSynthesisError | Cause.Done
    >();
    const frame = Uint8Array.from({ length: 208 }, (_, index) =>
      index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
    );
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offerAll(source, [
        { pcm: new Int16Array(4), rate: 24_000, startSeconds: 0, span: { start: 0, end: 16 } },
        frame,
      ]);
      // Starts while synthesis is still running, rather than holding audio until it ends.
      const token = yield* streams.start("xai", { ...request, from: 5 });
      yield* Queue.offer(source, frame);
      yield* Queue.end(source);
      expect(yield* audio(yield* streams.read(token))).toEqual([...frame, ...frame]);
    }).pipe(
      Effect.provide(withSource(Stream.fromQueue(source), { session: () => Effect.undefined })),
    );
  }),
);

it.effect.each([
  [
    "a provider error",
    Stream.fail(new SpeechSynthesisError({ provider: "xai", reason: "rate-limit" })),
    "rate-limit",
  ],
  ["no audio", Stream.empty, "unavailable"],
] as const)("fails to start on %s before any audio", ([, source, reason]) =>
  Effect.gen(function* () {
    const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
    expect(yield* Effect.flip(streams.start("xai", request))).toMatchObject({ reason });
  }).pipe(Effect.provide(withSource(source))),
);

it.effect("fails readers when synthesis breaks off after the first audio", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<Uint8Array, SpeechSynthesisError | Cause.Done>();
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offer(source, Uint8Array.of(1));
      const token = yield* streams.start("xai", request);
      yield* Queue.fail(
        source,
        new SpeechSynthesisError({ provider: "xai", reason: "unavailable" }),
      );
      expect(Exit.isFailure(yield* Effect.exit(audio(yield* streams.read(token))))).toBe(true);
    }).pipe(Effect.provide(withSource(Stream.fromQueue(source))));
  }),
);

it.effect.each([
  ["its reader leaves", true, "5 seconds"],
  ["nobody opens it", false, "30 seconds"],
] as const)("cancels synthesis when %s", ([, read, grace]) =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<Uint8Array, SpeechSynthesisError | Cause.Done>();
    const stopped = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offer(source, Uint8Array.of(1));
      const token = yield* streams.start("xai", request);
      if (read)
        expect(yield* audio((yield* streams.read(token))?.pipe(Stream.take(1)))).toEqual([1]);
      yield* TestClock.adjust(grace);
      yield* Deferred.await(stopped);
      expect(yield* streams.read(token)).toBeUndefined();
    }).pipe(
      Effect.provide(
        withSource(
          Stream.fromQueue(source).pipe(Stream.ensuring(Deferred.succeed(stopped, undefined))),
        ),
      ),
    );
  }),
);
