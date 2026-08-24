import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
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
// 404 page or, while the version is still propagating to the subdomain, the
// blue "Error 1104 / Script not found" page (served with a 5xx status). Both
// are transient propagation states, so retry through them until the worker
// answers 200 (and surface its body if it doesn't, so a real failure isn't
// hidden by the retry loop).
const looksLikeCloudflarePlaceholder = (body: string) =>
  body.includes("There is nothing here yet") ||
  // The "Error 1104 / Script not found" page renders the word "Error" and
  // the code in separate HTML tags, so match the page's own markers rather
  // than a contiguous "Error NNNN" string.
  body.includes("Script not found") ||
  body.includes("cf-error-code") ||
  /Error\s+\d{3,4}/i.test(body);

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
        e instanceof WorkerNotReady &&
        ((e.status >= 400 && e.status < 500) ||
          looksLikeCloudflarePlaceholder(e.body)),
      // Cap each backoff at 5s (otherwise the exponential blows past a minute
      // per sleep and looks like a hang) and stop after 30 attempts.
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("5 seconds"),
        ]),
        Schedule.recurs(30),
      ]),
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
