import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * 1x1 red PNG — a known-good minimal image that Cloudflare Images accepts and
 * reports as `image/png`, 1x1. The test uploads this to each worker, which
 * forwards the request stream straight into `images.info()`.
 */
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  ),
);

// Cloudflare's edge takes a few seconds to start serving a fresh workers.dev
// URL — initial requests can return Cloudflare's "There is nothing here yet"
// 404 page. Retry until the worker answers 200 (and surface its body if it
// doesn't, so a real failure isn't hidden by the retry loop).
const postImage = (url: string) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyUint8Array(TINY_PNG),
    ),
  ).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady =>
        e instanceof WorkerNotReady && e.status >= 400 && e.status < 500,
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "async worker reads image info via env Images binding",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;
    const info = yield* postImage(asyncWorkerUrl);
    expect(info).toMatchObject({
      mode: "async",
      format: "image/png",
      width: 1,
      height: 1,
    });
  }),
  { timeout: 240_000 },
);

test(
  "effect worker reads image info via yield* Images",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const info = yield* postImage(effectWorkerUrl);
    expect(info).toMatchObject({
      mode: "effect",
      format: "image/png",
      width: 1,
      height: 1,
    });
  }),
  { timeout: 240_000 },
);
