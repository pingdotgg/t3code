// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - the relay under test is a real Node HTTP server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import { channelKey } from "../environments/RelayChannelEndpoint.ts";
import { makeRelayChannels } from "./RelayChannels.ts";

const makeLayer = (credentialValid: () => boolean = () => true) =>
  Layer.mergeAll(
    NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
    Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
      create: () => Effect.die("unused"),
      authenticate: (token) =>
        Effect.sync(() =>
          token === "good" && credentialValid()
            ? Option.some({ credentialId: "c", environmentId: "env-1", environmentPublicKey: "k" })
            : Option.none(),
        ),
      revokeForEnvironmentPublicKey: () => Effect.die("unused"),
    }),
  );

const serveRelay = Effect.gen(function* () {
  yield* HttpServer.serveEffect(
    makeRelayChannels()(Effect.succeed(HttpServerResponse.text("relay api"))),
  );
  const { address } = yield* HttpServer.HttpServer;
  return "port" in address ? address.port : 0;
});

const channelPrefix = Effect.map(channelKey("env-1", "k"), (key) => `/env/${key}`);

/** A fake environment that answers each forwarded request with what it received. */
const connectEnvironment = (port: number, token: string) =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, string>((resume) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/environments/env-1/channel`, {
        headers: { authorization: `Bearer ${token}` },
      } as never);
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        // The relay pings once the channel is registered.
        if (frame.type === "ping") resume(Effect.succeed(socket));
        if (frame.type === "http-request") {
          const echo = `${frame.method} ${frame.path} ${frame.headers["x-forwarded-prefix"]}`;
          socket.send(
            JSON.stringify({
              type: "http-response",
              id: frame.id,
              status: 302,
              headers: { "content-type": "text/plain", location: "/next" },
              body: Buffer.from(echo).toString("base64"),
            }),
          );
        }
      });
      socket.addEventListener("close", (event) => resume(Effect.fail(`closed ${event.code}`)));
    }),
    (socket) => Effect.sync(() => socket.close()),
  );

const get = (port: number, path: string) =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
    return {
      status: response.status,
      body: await response.text(),
      location: response.headers.get("location"),
    };
  });

describe("makeRelayChannels", () => {
  it.live("forwards /env/<key> to its environment and leaves other paths to the relay", () =>
    Effect.gen(function* () {
      const port = yield* serveRelay;
      const prefix = yield* channelPrefix;
      yield* connectEnvironment(port, "good");

      expect(yield* get(port, `${prefix}/api/state?x=1`)).toEqual({
        status: 302,
        body: `GET /api/state?x=1 ${prefix}`,
        location: `${prefix}/next`,
      });
      expect(yield* get(port, "/v1/metadata")).toEqual({
        status: 200,
        body: "relay api",
        location: null,
      });
    }).pipe(Effect.scoped, Effect.provide(makeLayer())),
  );

  it.live("answers 502 for an environment that has no channel open", () =>
    Effect.gen(function* () {
      const port = yield* serveRelay;
      expect((yield* get(port, `${yield* channelPrefix}/`)).status).toBe(502);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "closes a channel once its credential is revoked, whatever the environment sends",
    () => {
      let valid = true;
      return Effect.gen(function* () {
        const port = yield* serveRelay;
        const socket = yield* connectEnvironment(port, "good");
        const closed = Effect.callback<void>((resume) =>
          socket.addEventListener("close", () => resume(Effect.void)),
        );
        valid = false;
        yield* TestClock.adjust("25 seconds");
        yield* closed;
        expect((yield* get(port, `${yield* channelPrefix}/`)).status).toBe(502);
      }).pipe(Effect.scoped, Effect.provide(makeLayer(() => valid)));
    },
  );

  it.live("refuses a channel opened with another credential", () =>
    Effect.gen(function* () {
      const port = yield* serveRelay;
      const opened = yield* Effect.exit(connectEnvironment(port, "bad"));
      expect(opened._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(makeLayer())),
  );
});
