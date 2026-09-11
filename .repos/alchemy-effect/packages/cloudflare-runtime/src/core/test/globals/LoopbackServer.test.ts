import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as LoopbackServer from "../../globals/LoopbackServer.ts";

layer(LoopbackServer.LoopbackServerLive)((it) => {
  it.effect("starts a loopback server", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      expect(loopbackServer).toMatchObject({
        address: expect.stringMatching(/^[0-9a-f-.]+:[0-9]+$/),
        secret: expect.any(String),
        route: expect.any(Function),
      });
    }),
  );

  it.effect("routes a request to a raw handler", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      yield* loopbackServer.route("test-raw", (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Hello, world!");
      });
      const response = yield* Effect.promise(() =>
        fetch(`http://${loopbackServer.address}`, {
          headers: {
            [LoopbackServer.LoopbackServerHeaders.TARGET]: "test-raw",
            [LoopbackServer.LoopbackServerHeaders.SECRET]:
              loopbackServer.secret,
          },
        }).then(async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          text: await res.text(),
        })),
      );
      expect(response).toMatchObject({
        status: 200,
        headers: { "content-type": "text/plain" },
        text: "Hello, world!",
      });
    }),
  );

  it.effect("routes a request to an effect handler", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      yield* loopbackServer.route(
        "test-effect",
        Effect.succeed(HttpServerResponse.text("Hello from Effect!")),
      );
      const response = yield* Effect.promise(() =>
        fetch(`http://${loopbackServer.address}`, {
          headers: {
            [LoopbackServer.LoopbackServerHeaders.SECRET]:
              loopbackServer.secret,
            [LoopbackServer.LoopbackServerHeaders.TARGET]: "test-effect",
          },
        }).then(async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          text: await res.text(),
        })),
      );
      expect(response).toMatchObject({
        status: 200,
        headers: { "content-type": "text/plain" },
        text: "Hello from Effect!",
      });
    }),
  );

  it.effect("returns a 404 for an unknown route", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      const response = yield* Effect.promise(() =>
        fetch(`http://${loopbackServer.address}`, {
          headers: {
            [LoopbackServer.LoopbackServerHeaders.SECRET]:
              loopbackServer.secret,
            [LoopbackServer.LoopbackServerHeaders.TARGET]: "test2",
          },
        }).then(async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          json: await res.json(),
        })),
      );
      expect(response).toMatchObject({
        status: 404,
        headers: { "content-type": "application/json" },
        json: {
          ok: false,
          error: {
            subtag: "NotFound",
            message: 'The route "test2" is not found.',
          },
        },
      });
    }),
  );

  it.effect("returns a 401 for an invalid secret", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      const response = yield* Effect.promise(() =>
        fetch(`http://${loopbackServer.address}`, {
          headers: {
            [LoopbackServer.LoopbackServerHeaders.SECRET]: "invalid",
            [LoopbackServer.LoopbackServerHeaders.TARGET]: "test3",
          },
        }).then(async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          json: await res.json(),
        })),
      );
      expect(response).toMatchObject({
        status: 401,
        headers: { "content-type": "application/json" },
        json: {
          ok: false,
          error: { subtag: "Unauthorized", message: "Unauthorized" },
        },
      });
    }),
  );

  it.effect("returns a 400 for an missing target", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      const response = yield* Effect.promise(() =>
        fetch(`http://${loopbackServer.address}`, {
          headers: {
            [LoopbackServer.LoopbackServerHeaders.SECRET]:
              loopbackServer.secret,
          },
        }).then(async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          json: await res.json(),
        })),
      );
      expect(response).toMatchObject({
        status: 400,
        headers: { "content-type": "application/json" },
        json: {
          ok: false,
          error: {
            subtag: "BadRequest",
            message: 'The "loopback-target" header is required.',
          },
        },
      });
    }),
  );

  it.effect("returns a 401 for a missing secret", () =>
    Effect.gen(function* () {
      const loopbackServer = yield* LoopbackServer.LoopbackServer;
      const response = yield* Effect.promise(() =>
        fetch(`http://${loopbackServer.address}`, {
          headers: {
            [LoopbackServer.LoopbackServerHeaders.TARGET]: "test3",
          },
        }).then(async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          json: await res.json(),
        })),
      );
      expect(response).toMatchObject({
        status: 400,
        headers: { "content-type": "application/json" },
        json: {
          ok: false,
          error: {
            subtag: "BadRequest",
            message: 'The "loopback-secret" header is required.',
          },
        },
      });
    }),
  );
});
