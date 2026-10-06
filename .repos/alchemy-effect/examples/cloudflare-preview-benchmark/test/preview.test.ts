import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  // `STAGE=pr-147 bun test` targets the stage `alchemy deploy --stage pr-147`
  // created; otherwise the harness default (`test_$USER`) is used.
  ...(process.env.STAGE ? { stage: process.env.STAGE } : {}),
});

// A no-op when the stage is already deployed.
const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!process.env.CI)(destroy(Stack));

test(
  "GET /photos renders the gallery",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // fresh workers.dev URLs can take a moment to start serving
    const res = yield* HttpClient.get(`${url}/photos`).pipe(
      Effect.filterOrFail((res) => res.status === 200),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 20 }),
    );
    const body = (yield* res.json) as { photos: string[] };
    expect(Array.isArray(body.photos)).toBe(true);
  }),
);

test(
  "uploads a photo to R2",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const put = yield* HttpClient.put(`${url}/photos/cat.jpg`, {
      body: HttpBody.text("fake-jpeg-bytes"),
    });
    expect(put.status).toBe(201);

    const res = yield* HttpClient.get(`${url}/photos`);
    const body = (yield* res.json) as { photos: string[] };
    expect(body.photos).toContain("cat.jpg");
  }),
);

test(
  "session survives a reload",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const first = (yield* (yield* HttpClient.get(`${url}/session`)).json) as {
      id: string;
    };
    const reload = yield* HttpClient.execute(
      HttpClientRequest.get(`${url}/session`).pipe(
        HttpClientRequest.setHeader("x-session-id", first.id),
      ),
    );
    const second = (yield* reload.json) as { value: string | null };
    expect(second.value).toBe(first.id);
  }),
);
