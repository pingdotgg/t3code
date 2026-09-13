import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const hasCreds = !!process.env.HCLOUD_TOKEN;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Hetzner.providers(), Neon.providers()),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
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
        times: 30,
      }),
    );
  });

if (!hasCreds) {
  test.skip("skipped without HCLOUD_TOKEN", Effect.void);
} else {
  const stack = beforeAll(deploy(Stack), { timeout: 240_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 180_000,
  });

  test(
    "SPA renders the Notes heading",
    Effect.gen(function* () {
      const { url } = yield* stack;
      if (!url) throw new Error("expected the site to expose a url");
      const base = String(url).replace(/\/+$/, "");
      const response = yield* executeOk(HttpClientRequest.get(`${base}/`));
      const body = yield* response.text;
      expect(body).toContain("Notes — Hetzner");
    }),
    { timeout: 180_000 },
  );

  test(
    "API persists a note in Postgres",
    Effect.gen(function* () {
      const { apiUrl } = yield* stack;
      if (!apiUrl) throw new Error("expected the API url");
      const base = String(apiUrl).replace(/\/+$/, "");
      const marker = `hetzner-note-${crypto.randomUUID()}`;
      yield* executeOk(
        HttpClientRequest.post(`${base}/notes`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body: marker }),
        ),
      );
      const listed = yield* executeOk(HttpClientRequest.get(`${base}/notes`));
      const payload = (yield* listed.json) as {
        notes: Array<{ body: string }>;
      };
      expect(payload.notes.some((note) => note.body === marker)).toBe(true);
    }),
    { timeout: 180_000 },
  );
}
