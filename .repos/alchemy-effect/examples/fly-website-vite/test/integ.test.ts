import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

const executeOk = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        res.status === 200 || res.status === 201
          ? Effect.succeed(res)
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 45,
      }),
    );
  });

test(
  "deploys the SPA and the API",
  Effect.gen(function* () {
    const { url, apiUrl } = yield* stack;
    expect(url).toBeString();
    expect(url).toMatch(/^https:\/\/.+\.fly\.dev$/);
    expect(apiUrl).toBeString();
    expect(apiUrl).toMatch(/^https:\/\/.+\.fly\.dev$/);
  }),
  { timeout: 120_000 },
);

test(
  "SPA renders the Notes heading",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (!url) throw new Error("expected the site to expose a fly.dev url");
    const html = yield* getBodyWhenReady(
      String(url).replace(/\/+$/, ""),
      "Notes — Fly",
    );
    expect(html).toContain("Notes — Fly");
  }),
  { timeout: 120_000 },
);

test(
  "API persists a note in Postgres",
  Effect.gen(function* () {
    const { apiUrl } = yield* stack;
    if (!apiUrl) throw new Error("expected the API url");
    const base = String(apiUrl).replace(/\/+$/, "");
    const marker = `fly-note-${crypto.randomUUID()}`;
    const created = yield* executeOk(
      HttpClientRequest.post(`${base}/notes`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ body: marker }),
      ),
    );
    expect(created.status).toBe(201);
    const listed = yield* executeOk(HttpClientRequest.get(`${base}/notes`));
    const payload = (yield* listed.json) as { notes: Array<{ body: string }> };
    expect(payload.notes.some((note) => note.body === marker)).toBe(true);
  }),
  { timeout: 180_000 },
);
