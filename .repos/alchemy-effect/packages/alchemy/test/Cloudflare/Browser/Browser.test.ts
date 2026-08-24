import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
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
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(20),
      ]),
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
  "effect worker exercises content via quickAction wrapper",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/content`)) as {
      title: string;
      contentLength: number;
    };

    expect(body.title).toBe("Example Domain");
    expect(body.contentLength).toBeGreaterThan(0);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker converts a page to markdown",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/markdown`)) as {
      markdownLength: number;
    };

    expect(body.markdownLength).toBeGreaterThan(0);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker extracts links",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/links`)) as {
      linkCount: number;
    };

    expect(body.linkCount).toBeGreaterThan(0);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker scrapes elements by selector",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/scrape`)) as {
      heading: string | null;
    };

    expect(body.heading).toBe("Example Domain");
  }),
  { timeout: 180_000 },
);

test(
  "effect worker takes a page snapshot",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/snapshot`)) as {
      title: string;
      screenshotLength: number;
    };

    expect(body.title).toBe("Example Domain");
    expect(body.screenshotLength).toBeGreaterThan(0);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker streams a screenshot",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/screenshot`)) as {
      bytes: number;
    };

    expect(body.bytes).toBeGreaterThan(0);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker streams a PDF",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/pdf`)) as {
      bytes: number;
    };

    expect(body.bytes).toBeGreaterThan(0);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker extracts JSON with AI",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/json`)) as {
      success: boolean;
    };

    expect(body.success).toBe(true);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker calls the generic quickAction",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/quickAction`)) as {
      title: string;
    };

    expect(body.title).toBe("Example Domain");
  }),
  { timeout: 180_000 },
);

test(
  "effect worker exposes the raw BrowserRun binding",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = (yield* readJson(`${effectWorkerUrl}/raw`)) as {
      title: string;
    };

    expect(body.title).toBe("Example Domain");
  }),
  { timeout: 180_000 },
);
