import { expect } from "bun:test";
import * as Fly from "@alchemy.run/fly";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200 ? Effect.succeed(res) : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        // Back off, but keep polling every 3s: a new fly.dev hostname can
        // take a minute or more to start serving.
        schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        times: 35,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test(
  "puts and gets an object on Tigris over HTTP",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.addOnId).toBeString();
    expect(out.bucketName).toBeString();
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);

    const health = yield* fetchOk(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);

    const response = yield* fetchOk(`${out.apiUrl}/`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(body.text).toBe("hello-from-tigris");
  }),
  { timeout: 180_000 },
);
