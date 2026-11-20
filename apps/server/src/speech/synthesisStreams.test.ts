import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
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
import * as SpeechSynthesisStreams from "./synthesisStreams.ts";

const request: SpeechSynthesisRequest = {
  text: "Read this reply.",
  model: "",
  voice: "",
  speed: 1,
  language: "en",
};

const withSource = (source: Stream.Stream<CloudSpeech.SpeechSynthesisPart, SpeechSynthesisError>) =>
  SpeechSynthesisStreams.layer.pipe(
    Layer.provide(Layer.mock(CloudSpeech.CloudSpeech)({ stream: () => source })),
    Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({})),
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
      const token = yield* streams.start("openai", request);
      const live = yield* Effect.forkChild(audio(yield* streams.read(token)));
      yield* Queue.offer(source, Uint8Array.of(2));
      yield* Queue.end(source);
      expect(yield* Fiber.join(live)).toEqual([1, 2]);
      expect(yield* audio(yield* streams.read(token))).toEqual([1, 2]);
      expect(yield* streams.read("unknown")).toBeUndefined();
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

it.effect.each([
  [
    "a provider error",
    Stream.fail(new SpeechSynthesisError({ provider: "openai", reason: "rate-limit" })),
    "rate-limit",
  ],
  ["no audio", Stream.empty, "unavailable"],
] as const)("fails to start on %s before any audio", ([, source, reason]) =>
  Effect.gen(function* () {
    const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
    expect(yield* Effect.flip(streams.start("openai", request))).toMatchObject({ reason });
  }).pipe(Effect.provide(withSource(source))),
);

it.effect("fails readers when synthesis breaks off after the first audio", () =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<Uint8Array, SpeechSynthesisError | Cause.Done>();
    yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      yield* Queue.offer(source, Uint8Array.of(1));
      const token = yield* streams.start("openai", request);
      yield* Queue.fail(
        source,
        new SpeechSynthesisError({ provider: "openai", reason: "unavailable" }),
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
      const token = yield* streams.start("openai", request);
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
