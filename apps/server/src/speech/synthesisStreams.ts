import {
  SPEECH_SYNTHESIS_AUDIO_PATH,
  SpeechSynthesisError,
  type ServerSettingsError,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisTimings,
  type SpeechSynthesisWord,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudSpeech from "./CloudSpeech.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as SpeechAligner from "./SpeechAligner.ts";
import { SPEECH_LEVEL_WINDOW_SECONDS, speechLevels } from "./synthesisLevels.ts";
import { mp3Duration, mp3FrameAt } from "./synthesisTimings.ts";

// A started stream nobody opens is abandoned.
const UNREAD_GRACE: Duration.Input = "30 seconds";
// Players reconnect, such as Safari probing a byte range before the real request.
const RECONNECT_GRACE: Duration.Input = "5 seconds";
// Finished audio stays for players that re-request it after playing.
const FINISHED_RETENTION: Duration.Input = "2 minutes";
// A timings read answers by then even when nothing changed, so a lost client is not held.
const TIMINGS_WAIT: Duration.Input = "10 seconds";
// New levels answer a timings read once this many exist, so a client is not woken per chunk.
const LEVELS_BATCH = 40;

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

function joined(chunks: ReadonlyArray<Uint8Array>) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

type Job = {
  readonly chunks: Uint8Array[];
  readonly words: SpeechSynthesisWord[];
  readonly duration: ReturnType<typeof mp3Duration>;
  readonly levels: ReturnType<typeof speechLevels>;
  readonly progress: SubscriptionRef.SubscriptionRef<{
    readonly count: number;
    readonly words: number;
    /** Loudness windows measured so far. */
    readonly levels: number;
    readonly done: boolean;
    /** Every word is timed; can trail `done` while the last audio is aligned. */
    readonly timed: boolean;
  }>;
  fiber?: Fiber.Fiber<void>;
  alignment?: Fiber.Fiber<void>;
  failed: boolean;
  readers: number;
  everRead: boolean;
  idle: number;
};

export class SpeechSynthesisStreams extends Context.Service<
  SpeechSynthesisStreams,
  {
    /** Resolves with a token once the first audio exists, so provider errors surface here. */
    readonly start: (
      provider: SpeechSynthesisProvider,
      request: SpeechSynthesisRequest,
    ) => Effect.Effect<string, SpeechSynthesisError | ServerSettingsError>;
    /** The audio from its start, then live as it is produced; `undefined` once expired. */
    readonly read: (token: string) => Effect.Effect<Stream.Stream<Uint8Array> | undefined>;
    /**
     * Words after the first `after`, once there are any or synthesis ends. With `levelsAfter`,
     * also the loudness levels after that many, answering once a batch of them exists.
     */
    readonly timings: (
      token: string,
      after: number,
      levelsAfter?: number,
    ) => Effect.Effect<SpeechSynthesisTimings>;
  }
>()("t3/speech/synthesisStreams/SpeechSynthesisStreams") {}

const make = Effect.gen(function* () {
  const cloud = yield* CloudSpeech.CloudSpeech;
  const local = yield* LocalSpeechSynthesis.LocalSpeechSynthesis;
  const aligner = yield* SpeechAligner.SpeechAligner;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;
  const jobs = new Map<string, Job>();

  // A later reader or idle period supersedes this one through `job.idle`.
  const expireWhenIdle = Effect.fnUntraced(function* (token: string, job: Job) {
    const generation = ++job.idle;
    const { done } = yield* SubscriptionRef.get(job.progress);
    yield* Effect.sleep(done ? FINISHED_RETENTION : job.everRead ? RECONNECT_GRACE : UNREAD_GRACE);
    if (job.idle !== generation || job.readers > 0) return;
    jobs.delete(token);
    if (job.fiber) yield* Fiber.interrupt(job.fiber);
    if (job.alignment) yield* Fiber.interrupt(job.alignment);
  });

  const start = Effect.fn("SpeechSynthesisStreams.start")(function* (
    provider: SpeechSynthesisProvider,
    request: SpeechSynthesisRequest,
  ) {
    const source: Stream.Stream<
      CloudSpeech.SpeechSynthesisPart,
      SpeechSynthesisError | ServerSettingsError
    > = provider === "local" ? local.stream(request) : cloud.stream(provider, request);
    const first = yield* Deferred.make<void, SpeechSynthesisError | ServerSettingsError>();
    // Speech that starts at a word is made from its sentence's start for context. Its audio is
    // held until that word is timed, then released from the frame it starts in, with the
    // earlier words dropped and later ones shifted to the released audio's clock.
    const from =
      request.from !== undefined && request.from < request.text.length ? request.from : 0;
    const job: Job = {
      chunks: [],
      words: [],
      duration: mp3Duration(),
      // Measured on the whole synthesis; a lead-in is cut from them where its audio is.
      levels: speechLevels(from > 0),
      progress: yield* SubscriptionRef.make({
        count: 0,
        words: 0,
        levels: 0,
        done: false,
        timed: false,
      }),
      failed: false,
      readers: 0,
      everRead: false,
      idle: 0,
    };
    const publishWords = (words: ReadonlyArray<SpeechSynthesisWord>) =>
      words.length
        ? Effect.sync(() => job.words.push(...words)).pipe(
            Effect.andThen(
              SubscriptionRef.update(job.progress, (progress) => ({
                ...progress,
                words: job.words.length,
              })),
            ),
          )
        : Effect.void;
    const publishLevels = SubscriptionRef.update(job.progress, (progress) => ({
      ...progress,
      levels: job.levels.count,
    }));
    const publishChunk = (chunk: Uint8Array) =>
      Effect.sync(() => {
        job.chunks.push(chunk);
        job.duration.push(chunk);
      }).pipe(
        Effect.andThen(
          SubscriptionRef.update(job.progress, (progress) => ({
            ...progress,
            count: job.chunks.length,
            levels: job.levels.count,
          })),
        ),
        Effect.andThen(Deferred.succeed(first, undefined)),
      );
    const lead =
      from > 0
        ? {
            held: [] as Uint8Array[],
            words: [] as SpeechSynthesisWord[],
            cut: -1,
            // The whole synthesis, lead-in included, which its PCM and timings are measured on.
            total: mp3Duration(),
          }
        : undefined;
    const shifted = (words: ReadonlyArray<SpeechSynthesisWord>, cut: number) =>
      words
        .filter((word) => word.end > from)
        .map((word) => ({
          ...word,
          startSeconds: round(Math.max(0, word.startSeconds - cut)),
          endSeconds: round(Math.max(0, word.endSeconds - cut)),
        }));
    // `force` releases what is held once no more timings can come, from the start if need be.
    const release = (force: boolean) =>
      Effect.suspend(() => {
        if (!lead || lead.cut >= 0) return Effect.void;
        const target = lead.words.find((word) => word.end > from)?.startSeconds;
        if (target === undefined && !force) return Effect.void;
        const bytes = joined(lead.held);
        const frame =
          (target === undefined ? undefined : mp3FrameAt(bytes, target)) ??
          (force ? { offset: 0, seconds: 0 } : undefined);
        if (!frame) return Effect.void;
        lead.cut = frame.seconds;
        job.levels.start(frame.seconds);
        const words = shifted(lead.words, frame.seconds);
        lead.held = [];
        lead.words = [];
        const audio = bytes.subarray(frame.offset);
        return (audio.length ? publishChunk(audio) : Effect.void).pipe(
          Effect.andThen(publishWords(words)),
        );
      });
    const addWords = (words: ReadonlyArray<SpeechSynthesisWord>) => {
      if (!lead) return publishWords(words);
      if (lead.cut >= 0) return publishWords(shifted(words, lead.cut));
      lead.words.push(...words);
      return release(false);
    };
    const addChunk = (chunk: Uint8Array) => {
      if (!lead) return publishChunk(chunk);
      lead.total.push(chunk);
      if (lead.cut >= 0) return publishChunk(chunk);
      lead.held.push(chunk);
      return release(false);
    };
    // Audio that comes without word timings is timed from its PCM, off the audio's own path.
    const pcm = yield* Queue.unbounded<SpeechAligner.AlignmentAudio, Cause.Done>();
    job.alignment = yield* Effect.gen(function* () {
      // Opened on the first PCM, so providers with their own timings never load a model.
      const opened: { session?: SpeechAligner.AlignmentSession | undefined } = {};
      yield* Stream.fromQueue(pcm).pipe(
        Stream.runForEach((part) =>
          Effect.gen(function* () {
            if (!("session" in opened)) {
              opened.session = yield* aligner.session(request.text, request.language);
              // Without a timing model the word is never timed; play from the lead-in instead.
              if (!opened.session) yield* release(true);
            }
            if (opened.session) yield* addWords(yield* opened.session.push(part));
          }),
        ),
      );
      if (opened.session && !job.failed) yield* addWords(yield* opened.session.finish);
      yield* release(true);
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(job.progress, (progress) => ({ ...progress, timed: true })),
      ),
      Effect.forkIn(scope),
    );
    job.fiber = yield* source.pipe(
      Stream.runForEach((part) => {
        if ("pcm" in part) {
          job.levels.pushPcm(part.pcm, part.rate, part.startSeconds);
          return Queue.offer(pcm, part).pipe(Effect.andThen(publishLevels));
        }
        if (!(part instanceof Uint8Array)) return addWords(part.words);
        job.levels.pushMp3(part);
        return addChunk(part);
      }),
      Effect.onExit((exit) => {
        job.failed = Exit.isFailure(exit);
        job.levels.finish();
        Queue.endUnsafe(pcm);
        const alignment = job.alignment;
        // Held audio is released by the alignment once it has timed the last of it.
        return (lead && alignment ? Fiber.await(alignment) : Effect.void).pipe(
          Effect.andThen(release(true)),
          Effect.andThen(
            SubscriptionRef.update(job.progress, (progress) => ({
              ...progress,
              count: job.chunks.length,
              levels: job.levels.count,
              done: true,
            })).pipe(
              Effect.andThen(
                Exit.isFailure(exit)
                  ? Deferred.failCause(first, exit.cause)
                  : job.chunks.length
                    ? Effect.void
                    : Effect.logWarning("Speech synthesis produced no audio.", { provider }).pipe(
                        Effect.andThen(
                          Deferred.fail(
                            first,
                            new SpeechSynthesisError({ provider, reason: "unavailable" }),
                          ),
                        ),
                      ),
              ),
            ),
          ),
        );
      }),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    const synthesis = job.fiber;
    yield* Deferred.await(first).pipe(Effect.onInterrupt(() => Fiber.interrupt(synthesis)));
    const token = yield* random.uuidV4();
    jobs.set(token, job);
    yield* expireWhenIdle(token, job).pipe(Effect.forkIn(scope));
    return token;
  });

  const read = (token: string) =>
    Effect.sync(() => {
      const job = jobs.get(token);
      if (!job) return undefined;
      const tracked = Effect.acquireRelease(
        Effect.sync(() => {
          job.readers++;
          job.everRead = true;
          job.idle++;
        }),
        () =>
          Effect.suspend(() =>
            --job.readers === 0
              ? expireWhenIdle(token, job).pipe(Effect.forkIn(scope), Effect.asVoid)
              : Effect.void,
          ),
      );
      return Stream.unwrap(
        tracked.pipe(
          Effect.as(
            SubscriptionRef.changes(job.progress).pipe(
              Stream.takeUntil((progress) => progress.done),
              Stream.mapAccum(
                () => 0,
                (sent, progress) => [progress.count, job.chunks.slice(sent, progress.count)],
              ),
              // A cut-off stream must fail the player rather than end as if complete.
              Stream.concat(
                Stream.suspend(() =>
                  job.failed ? Stream.die(new Error("Speech synthesis failed.")) : Stream.empty,
                ),
              ),
            ),
          ),
        ),
      );
    });

  const timings = Effect.fn("SpeechSynthesisStreams.timings")(function* (
    token: string,
    after: number,
    levelsAfter?: number,
  ) {
    const job = jobs.get(token);
    if (!job) return { words: [], done: true };
    const newLevels = (progress: { readonly levels: number; readonly done: boolean }) =>
      levelsAfter !== undefined &&
      (progress.levels >= levelsAfter + LEVELS_BATCH ||
        (progress.done && progress.levels > levelsAfter));
    yield* SubscriptionRef.changes(job.progress).pipe(
      Stream.filter((progress) => progress.timed || progress.words > after || newLevels(progress)),
      Stream.runHead,
      Effect.timeoutOption(TIMINGS_WAIT),
    );
    const { timed } = yield* SubscriptionRef.get(job.progress);
    const levels = levelsAfter === undefined ? [] : job.levels.slice(levelsAfter);
    return {
      words: job.words.slice(after),
      done: timed,
      ...(timed && !job.failed ? { durationSeconds: job.duration.seconds } : {}),
      ...(levelsAfter !== undefined && levels.length
        ? {
            levels: {
              windowSeconds: SPEECH_LEVEL_WINDOW_SECONDS,
              start: levelsAfter,
              values: levels,
            },
          }
        : {}),
    };
  });

  return SpeechSynthesisStreams.of({ start, read, timings });
});

export const layer = Layer.effect(SpeechSynthesisStreams, make);

export const speechSynthesisAudioRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const streams = yield* SpeechSynthesisStreams;
    return HttpRouter.add(
      "GET",
      SPEECH_SYNTHESIS_AUDIO_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = Option.flatMapNullishOr(HttpServerRequest.toURL(request), (url) =>
          url.searchParams.get("token"),
        );
        const audio = Option.isSome(token) ? yield* streams.read(token.value) : undefined;
        if (!audio) return HttpServerResponse.empty({ status: 404 });
        return HttpServerResponse.stream(audio, {
          contentType: "audio/mpeg",
          // no-transform keeps compression and proxies from buffering the live stream.
          headers: { "cache-control": "no-store, no-transform" },
        });
      }),
    );
  }),
);
