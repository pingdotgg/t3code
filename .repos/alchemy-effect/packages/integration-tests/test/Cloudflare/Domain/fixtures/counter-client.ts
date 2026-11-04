import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker, waitUntilStable } from "../../Utils/WorkerRequest.ts";

class NotReady extends Data.TaggedError("NotReady")<{
  readonly url: string;
  readonly status: number;
}> {}

class NotYet extends Data.TaggedError("NotYet")<{
  readonly url: string;
  readonly body: unknown;
}> {}

/** POST a counter route and return its JSON, retrying while the Worker starts. */
export const call = (url: string) =>
  Effect.gen(function* () {
    const response = yield* requestWorker(HttpClientRequest.post(url)).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : Effect.fail(new NotReady({ url, status: response.status })),
      ),
      Effect.retry({
        while: (error) => error._tag === "NotReady" && error.status === 404,
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
    return (yield* response.json) as unknown;
  });

/** Poll a route until it answers `expected`: views and sagas catch up after the command. */
export const eventually = (url: string, expected: unknown) =>
  call(url).pipe(
    Effect.flatMap((body) =>
      JSON.stringify(body) === JSON.stringify(expected)
        ? Effect.succeed(body)
        : Effect.fail(new NotYet({ url, body })),
    ),
    Effect.retry({
      while: (error) => error._tag === "NotYet",
      schedule: Schedule.spaced("1 second"),
      times: 30,
    }),
  );

/**
 * Two increments of `c-1` reach its aggregate, its view, and, through the
 * policy and the saga, its Echo; `c-2` stays untouched.
 */
export const roundTrip = (url: string) =>
  Effect.gen(function* () {
    expect(yield* call(`${url}/state/c-1`)).toEqual({ total: 0 });
    expect(yield* call(`${url}/increment/c-1`)).toEqual({ total: 2 });
    expect(yield* call(`${url}/increment/c-1`)).toEqual({ total: 4 });
    yield* eventually(`${url}/total/c-1`, { total: 4 });
    // The saga runs once per counter, with the first increment.
    yield* eventually(`${url}/echo/c-1`, { total: 2 });
    // A different key is a different instance.
    expect(yield* call(`${url}/state/c-2`)).toEqual({ total: 0 });
  });

/**
 * Wait until every host serves the version deployed on `platform`: Cloudflare
 * rolls a new version out host by host.
 */
export const waitForPlatform = (url: string, platform: "eu" | "unrestricted") =>
  waitUntilStable(
    `${platform} platform at ${url}`,
    Effect.map(
      call(`${url}/platform`),
      (body) => JSON.stringify(body) === JSON.stringify({ platform }),
    ),
  );
