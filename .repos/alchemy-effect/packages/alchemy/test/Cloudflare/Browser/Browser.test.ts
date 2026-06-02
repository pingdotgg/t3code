import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

const readJson = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
  ).pipe(
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "async worker renders a page title through Browser Rendering",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${asyncWorkerUrl}/title`)) as {
      mode: string;
      title: string;
    };

    expect(body.mode).toBe("async");
    expect(body.title).toBe("Example Domain");
  }),
  { timeout: 180_000 },
);

test(
  "effect worker renders a page title through Browser Rendering",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/title`)) as {
      mode: string;
      title: string;
    };

    expect(body.mode).toBe("effect");
    expect(body.title).toBe("Example Domain");
  }),
  { timeout: 180_000 },
);
