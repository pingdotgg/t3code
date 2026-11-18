import {
  SPEECH_SYNTHESIS_AUDIO_PATH,
  SpeechSynthesisError,
  type ServerSettingsError,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudSpeech from "./CloudSpeech.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";

// A started stream nobody opens is abandoned.
const UNREAD_GRACE: Duration.Input = "30 seconds";
// Players reconnect, such as Safari probing a byte range before the real request.
const RECONNECT_GRACE: Duration.Input = "5 seconds";
// Finished audio stays for players that re-request it after playing.
const FINISHED_RETENTION: Duration.Input = "2 minutes";

type Job = {
  readonly chunks: Uint8Array[];
  readonly progress: SubscriptionRef.SubscriptionRef<{
    readonly count: number;
    readonly done: boolean;
  }>;
  fiber?: Fiber.Fiber<void>;
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
  }
>()("t3/speech/synthesisStreams/SpeechSynthesisStreams") {}

const make = Effect.gen(function* () {
  const cloud = yield* CloudSpeech.CloudSpeech;
  const local = yield* LocalSpeechSynthesis.LocalSpeechSynthesis;
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
  });

  const start = Effect.fn("SpeechSynthesisStreams.start")(function* (
    provider: SpeechSynthesisProvider,
    request: SpeechSynthesisRequest,
  ) {
    const source = provider === "local" ? local.stream(request) : cloud.stream(provider, request);
    const first = yield* Deferred.make<void, SpeechSynthesisError | ServerSettingsError>();
    const job: Job = {
      chunks: [],
      progress: yield* SubscriptionRef.make({ count: 0, done: false }),
      failed: false,
      readers: 0,
      everRead: false,
      idle: 0,
    };
    job.fiber = yield* source.pipe(
      Stream.runForEach((chunk) => {
        job.chunks.push(chunk);
        return SubscriptionRef.set(job.progress, { count: job.chunks.length, done: false }).pipe(
          Effect.andThen(Deferred.succeed(first, undefined)),
        );
      }),
      Effect.onExit((exit) => {
        job.failed = Exit.isFailure(exit);
        return SubscriptionRef.set(job.progress, { count: job.chunks.length, done: true }).pipe(
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

  return SpeechSynthesisStreams.of({ start, read });
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
