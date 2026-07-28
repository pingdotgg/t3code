import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import WriteBindingWorker from "./fixtures/write-binding.ts";
import WriteHttpWorker from "./fixtures/write-http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

const ready = Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(20)]);

/** POST and retry until the producer route accepts the message (202). */
const post = (base: string, path: string, body?: string) => {
  const base$ = HttpClientRequest.post(`${base}${path}`);
  const req =
    body !== undefined ? HttpClientRequest.bodyText(base$, body) : base$;
  return HttpClient.execute(req).pipe(
    Effect.flatMap((res) =>
      res.status === 202
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((b) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body: b })),
            ),
          ),
    ),
    Effect.retry({
      // Ride out cold-start propagation — a fresh workers.dev URL
      // serves 404 ("nothing here yet") or 500 (code 1104 "Script not
      // found") for a few seconds before the script goes live. The
      // bounded spaced schedule caps total wait so a genuine failure
      // (worker returns its own JSON error body) still surfaces.
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );
};

/**
 * Cloudflare Queue is producer-only at the binding layer, so there is
 * no Read/ReadWrite split — only a Write producer. This deploys two
 * Workers that both bind one shared queue (native Worker binding and
 * scoped HTTP API token), then drives every {@link WriteQueueClient}
 * method over `fetch` — `send` and `sendBatch`, each in its JSON and
 * `text` content-type form — and asserts the producer accepts the
 * messages (202), proving the binding/token are wired and reach the
 * real queue.
 */
test.provider(
  "Queue write producer over binding + http",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const writeBinding = yield* WriteBindingWorker;
          const writeHttp = yield* WriteHttpWorker;
          return {
            writeBinding: writeBinding.url,
            writeHttp: writeHttp.url,
          };
        }),
      );

      const url = (u: unknown) => {
        expect(u).toBeTypeOf("string");
        return u as string;
      };

      // Drive the full producer surface (send + sendBatch, json + text)
      // against one base url.
      const exercise = (base: string, label: string) =>
        Effect.gen(function* () {
          expect((yield* post(base, "/send", `${label}-json`)).status).toBe(
            202,
          );
          expect(
            (yield* post(base, "/send-text", `${label}-text`)).status,
          ).toBe(202);
          expect((yield* post(base, "/sendBatch")).status).toBe(202);
          expect((yield* post(base, "/sendBatch-text")).status).toBe(202);
        });

      // ── Native binding producer ──
      yield* exercise(url(out.writeBinding), "binding");
      // ── HTTP token producer ──
      yield* exercise(url(out.writeHttp), "http");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
