import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { ShortyApi } from "../src/ShortyApi.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
});

// Deploy a full copy of the stack to stage test_$USER, and tear it down after.
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// The same typed client the dashboard uses, pointed at the test deployment.
const client = Effect.gen(function* () {
  const { api } = yield* stack;
  yield* Test.getWhenReady(`${api}/links`); // fresh workers.dev URLs take a moment
  return yield* HttpApiClient.make(ShortyApi, { baseUrl: api });
});

/**
 * Open a short link the way a browser would, without following the redirect.
 * Retries cold-start 404/5xx responses while a fresh deploy rolls out.
 */
const click = (url: string) =>
  Test.executeWhenReady(HttpClientRequest.get(url)).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

test(
  "creates and reads back a link",
  Effect.gen(function* () {
    const shorty = yield* client;
    const link = yield* shorty.links.create({ payload: { url: "https://effect.website" } });

    const found = yield* shorty.links.get({ params: { code: link.code } });
    expect(found.url).toBe("https://effect.website");

    const all = yield* shorty.links.list();
    expect(all.map((l) => l.code)).toContain(link.code);
  }),
);

test(
  "a missing link is a typed LinkNotFound",
  Effect.gen(function* () {
    const shorty = yield* client;
    const error = yield* shorty.links.get({ params: { code: "nope" } }).pipe(Effect.flip);
    expect(error._tag).toBe("LinkNotFound");
  }),
);

test(
  "a short link redirects to its URL",
  Effect.gen(function* () {
    const { api } = yield* stack;
    const shorty = yield* client;
    const link = yield* shorty.links.create({ payload: { url: "https://alchemy.run/" } });

    const response = yield* click(`${api}/${link.code}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://alchemy.run/");
  }),
);

test(
  "clicks are pushed live to open WebSockets",
  Effect.scoped(
    Effect.gen(function* () {
      const { api } = yield* stack;
      const shorty = yield* client;
      const link = yield* shorty.links.create({ payload: { url: "https://effect.website" } });

      // Watch the link's room, like the dashboard does.
      const counts: number[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(`${api.replace(/^http/, "ws")}/links/${link.code}/live`);
          socket.onmessage = (event) => counts.push(JSON.parse(String(event.data)).clicks);
          return socket;
        }),
        (socket) => Effect.sync(() => socket.close()),
      );
      const latest = Effect.sync(() => counts.at(-1));
      const poll = { schedule: Schedule.spaced("500 millis"), times: 120 };

      expect(yield* latest.pipe(Effect.repeat({ ...poll, until: (n) => n !== undefined }))).toBe(0);

      expect((yield* click(`${api}/${link.code}`)).status).toBe(302);
      expect((yield* click(`${api}/${link.code}`)).status).toBe(302);

      expect(yield* latest.pipe(Effect.repeat({ ...poll, until: (n) => n === 2 }))).toBe(2);
    }),
  ),
);
