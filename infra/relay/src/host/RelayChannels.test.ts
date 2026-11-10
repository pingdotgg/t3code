import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import { channelHostname, channelKey } from "../environments/RelayChannelEndpoint.ts";
import { withRelayChannels } from "./RelayChannels.ts";

const CHANNEL_HOST = "t3-*.relay.test";

const layer = Layer.mergeAll(
  NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
  Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
    create: () => Effect.die("unused"),
    authenticate: (token) =>
      Effect.succeed(
        token === "good"
          ? Option.some({ credentialId: "c", environmentId: "env-1", environmentPublicKey: "k" })
          : Option.none(),
      ),
    revokeForEnvironmentPublicKey: () => Effect.die("unused"),
  }),
);

const serveRelay = Effect.gen(function* () {
  yield* HttpServer.serveEffect(
    withRelayChannels(CHANNEL_HOST)(Effect.succeed(HttpServerResponse.text("relay api"))),
  );
  const { address } = yield* HttpServer.HttpServer;
  return "port" in address ? address.port : 0;
});

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
          const echo = `${frame.method} ${frame.path} ${frame.headers.host}`;
          socket.send(
            JSON.stringify({
              type: "http-response",
              id: frame.id,
              status: 201,
              headers: { "content-type": "text/plain", "x-environment": "yes" },
              body: Buffer.from(echo).toString("base64"),
            }),
          );
        }
      });
      socket.addEventListener("close", (event) => resume(Effect.fail(`closed ${event.code}`)));
    }),
    (socket) => Effect.sync(() => socket.close()),
  );

const get = (port: number, host: string, path = "/") =>
  Effect.callback<{ readonly status: number; readonly body: string; readonly env?: string }>(
    (resume) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port, path, headers: { host } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                body,
                ...(typeof response.headers["x-environment"] === "string"
                  ? { env: response.headers["x-environment"] }
                  : {}),
              }),
            ),
          );
        },
      );
      request.on("error", (error) => resume(Effect.die(error)));
      request.end();
    },
  );

describe("withRelayChannels", () => {
  it.live("forwards a channel host to its environment and leaves other hosts to the relay", () =>
    Effect.gen(function* () {
      const port = yield* serveRelay;
      const host = channelHostname(CHANNEL_HOST, yield* channelKey("env-1"));
      yield* connectEnvironment(port, "good");

      expect(yield* get(port, host, "/api/state?x=1")).toEqual({
        status: 201,
        body: `GET /api/state?x=1 ${host}`,
        env: "yes",
      });
      expect(yield* get(port, "relay.test")).toEqual({ status: 200, body: "relay api" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("answers 502 for an environment that has no channel open", () =>
    Effect.gen(function* () {
      const port = yield* serveRelay;
      const host = channelHostname(CHANNEL_HOST, yield* channelKey("env-1"));
      expect((yield* get(port, host)).status).toBe(502);
    }).pipe(Effect.provide(layer)),
  );

  it.live("refuses a channel opened with another credential", () =>
    Effect.gen(function* () {
      const port = yield* serveRelay;
      const opened = yield* Effect.exit(connectEnvironment(port, "bad"));
      expect(opened._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
