import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import { expect } from "alchemy-test";

export const functionRolloutTimeout = 900_000;

/** Poll immediately, then require eight consecutive current-version samples. */
export const functionRolloutSamples = <A, E, R>(
  sample: Effect.Effect<A, E, R>,
  isCurrent: (value: A) => boolean,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const samples: A[] = [];
    let consecutive = 0;
    let firstCurrentMs: number | undefined;
    let lastStaleMs: number | undefined;
    const poll = Effect.gen(function* () {
      const value = yield* sample.pipe(Effect.timeout("25 seconds"));
      const elapsedMs = (yield* Clock.currentTimeMillis) - started;
      const current = isCurrent(value);
      samples.push(value);
      consecutive = current ? consecutive + 1 : 0;
      if (current) firstCurrentMs ??= elapsedMs;
      else lastStaleMs = elapsedMs;
      yield* Effect.logInfo(
        JSON.stringify({
          neonRolloutSample: {
            round: samples.length,
            elapsedMs,
            current,
            consecutive,
          },
        }),
      );
      return consecutive >= 8;
    });
    const converged = yield* poll.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        times: 119,
        until: (done) => done,
      }),
      Effect.timeout("10 minutes"),
    );
    yield* Effect.logInfo(
      JSON.stringify({
        neonRollout: {
          converged,
          observations: samples.length,
          firstCurrentMs,
          lastStaleMs,
          confirmedAtMs: (yield* Clock.currentTimeMillis) - started,
        },
      }),
    );
    expect(converged).toBe(true);
    return samples.slice(-8);
  });

/** Compare the shared HTTP client with a fresh, proxy-bypassing connection. */
export const functionTextSamples = (
  url: string,
  isCurrent: (body: string) => boolean,
) =>
  functionRolloutSamples(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(url, {
        headers: { "cache-control": "no-cache" },
      });
      expect(response.status).toBe(200);
      const text = yield* response.text;
      const child = yield* ChildProcess.make("curl", [
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "10",
        "--http1.1",
        "--noproxy",
        "*",
        "-H",
        "Connection: close",
        "-H",
        "Cache-Control: no-cache",
        url,
      ]);
      const [exit, fresh] = yield* Effect.all(
        [child.exitCode, child.stdout.pipe(Stream.decodeText, Stream.mkString)],
        { concurrency: "unbounded" },
      );
      expect(Number(exit)).toBe(0);
      return [text, fresh] as const;
    }),
    (samples) => samples.every(isCurrent),
  ).pipe(Effect.map((samples) => samples.flat()));
