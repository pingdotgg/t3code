import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schedule from "effect/Schedule";
import type { RecorderSnapshot } from "./queue-sink-worker.ts";

/** Test-side HTTP helpers shared by the live and local QueueSink suites. */

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  run: string;
  status: number;
}> {
  override get message() {
    return `POST /produce for run "${this.run}" answered ${this.status}`;
  }
}

class NotDrained extends Data.TaggedError("NotDrained")<{
  run: string;
  expected: number;
  distinct: number;
}> {
  override get message() {
    return `run "${this.run}": ${this.distinct}/${this.expected} distinct messages drained`;
  }
}

/**
 * `POST /produce`, retrying while a fresh workers.dev URL comes up: its 404
 * placeholder has been observed to outlast 40 seconds. Bounded to roughly
 * 85 seconds.
 */
export const produce = (url: string, params: { run: string; count: number; padding?: number }) =>
  HttpClient.post(
    `${url}/produce?run=${params.run}&count=${params.count}&padding=${params.padding ?? 0}`,
  ).pipe(
    Effect.flatMap((res) =>
      res.status === 202
        ? Effect.succeed(res)
        : Effect.fail(new WorkerNotReady({ run: params.run, status: res.status })),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        Schedule.recurs(30),
      ]),
    }),
  );

/** Poll `GET /count` until every produced index reached the result queue. */
export const awaitDrained = (url: string, run: string, expected: number) =>
  HttpClient.get(`${url}/count?run=${run}`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as unknown as RecorderSnapshot),
    Effect.flatMap((snapshot) =>
      snapshot.distinct >= expected
        ? Effect.succeed(snapshot)
        : Effect.fail(new NotDrained({ run, expected, distinct: snapshot.distinct })),
    ),
    // GET /count is idempotent: retry any failure (edge 404s, a waking DO's
    // 500) as well as an incomplete count. Bounded to roughly 90 seconds.
    Effect.retry({
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("4 seconds")]),
        Schedule.recurs(25),
      ]),
    }),
  );
