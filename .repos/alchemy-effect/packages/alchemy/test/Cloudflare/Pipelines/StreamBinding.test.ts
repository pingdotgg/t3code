import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const forbiddenBlips = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

const asyncWorkerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

// A freshly-deployed workers.dev URL takes a few seconds to start serving,
// so the first request is retried until the worker answers.
const sendEvent = (url: string, nonce: string) =>
  HttpClient.get(`${url}/send?nonce=${nonce}`).pipe(
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
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
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
  "async worker sends events through the env Pipelines stream binding",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;

    const body = yield* sendEvent(asyncWorkerUrl, "async");

    // `send` only exists on a real `pipelines` binding — a `json` binding
    // would deliver the stream's attributes as a plain object.
    expect(body).toMatchObject({ mode: "async", sent: true, kind: "function" });
  }),
  { timeout: 240_000 },
);

test(
  "effect worker sends events through the env Pipelines stream binding",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;

    const body = yield* sendEvent(effectWorkerUrl, "effect");

    expect(body).toMatchObject({
      mode: "effect",
      sent: true,
      kind: "function",
    });
  }),
  { timeout: 240_000 },
);

test.provider(
  "the deployed worker carries a pipelines binding holding the stream id",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { stream, worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const stream = yield* Cloudflare.Pipelines.Stream("InlineStream", {});
          const worker = yield* Cloudflare.Worker("pipelines-binding-worker", {
            script: asyncWorkerScript,
            env: {
              EVENTS: stream,
            },
          });
          return { stream, worker };
        }),
      );

      const settings = yield* workers
        .getScriptScriptAndVersionSetting({
          accountId,
          scriptName: worker.workerName,
        })
        .pipe(Effect.retry(forbiddenBlips));

      const binding = (settings.bindings ?? []).find(
        (b) => b.name === "EVENTS",
      );

      expect(binding).toMatchObject({
        type: "pipelines",
        name: "EVENTS",
        pipeline: stream.streamId,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
