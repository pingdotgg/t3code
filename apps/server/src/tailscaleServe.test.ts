import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { acquireTailscaleServe, releaseTailscaleServe } from "./tailscaleServe.ts";

const encoder = new TextEncoder();

const descriptorJson = JSON.stringify({
  environmentId: "environment-primary",
  label: "primary",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.38",
  capabilities: {},
});

const serveStatusJson = (localPort: number) =>
  JSON.stringify({
    TCP: { "10010": { HTTPS: true } },
    Web: {
      "host.tail.ts.net:10010": {
        Handlers: { "/": { Proxy: `http://127.0.0.1:${String(localPort)}` } },
      },
    },
  });

function mockHandle(stdout: string) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Records every tailscale invocation and answers `serve status` with `status`. */
function spawnerLayer(status: string) {
  const commands: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
      commands.push(args);
      return Effect.succeed(mockHandle(args[1] === "status" ? status : ""));
    }),
  );
  return { commands, layer };
}

/** Answers the local descriptor probe: a live T3 server, or nothing listening. */
function httpClientLayer(alive: boolean) {
  const probed: Array<string> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      probed.push(request.url);
      return alive
        ? Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(descriptorJson, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          )
        : Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "connection refused",
                cause: new Error("ECONNREFUSED"),
              }),
            }),
          );
    }),
  );
  return { probed, layer };
}

const serveWrites = (commands: ReadonlyArray<ReadonlyArray<string>>) =>
  commands.filter((args) => args[1] === "--bg");

describe("tailscaleServe", () => {
  it.effect("writes the mapping when the serve port is free", () => {
    const spawner = spawnerLayer("{}");
    const http = httpClientLayer(false);

    return Effect.gen(function* () {
      const owned = yield* acquireTailscaleServe({ localPort: 3773, servePort: 10010 });

      assert.deepEqual(owned, { localPort: 3773, servePort: 10010 });
      assert.deepEqual(serveWrites(spawner.commands), [
        ["serve", "--bg", "--https=10010", "http://127.0.0.1:3773"],
      ]);
      assert.deepEqual(http.probed, []);
    }).pipe(Effect.provide(Layer.merge(spawner.layer, http.layer)));
  });

  it.effect("keeps a mapping that already fronts a live server on another port", () => {
    const spawner = spawnerLayer(serveStatusJson(3773));
    const http = httpClientLayer(true);

    return Effect.gen(function* () {
      // The second desktop instance: same environment, next free backend port.
      const owned = yield* acquireTailscaleServe({ localPort: 3774, servePort: 10010 });

      assert.equal(owned, null);
      assert.deepEqual(serveWrites(spawner.commands), []);
      assert.deepEqual(http.probed, ["http://127.0.0.1:3773/.well-known/t3/environment"]);
    }).pipe(Effect.provide(Layer.merge(spawner.layer, http.layer)));
  });

  it.effect("reclaims a mapping whose target no longer answers", () => {
    const spawner = spawnerLayer(serveStatusJson(3774));
    const http = httpClientLayer(false);

    return Effect.gen(function* () {
      const owned = yield* acquireTailscaleServe({ localPort: 3773, servePort: 10010 });

      assert.deepEqual(owned, { localPort: 3773, servePort: 10010 });
      assert.deepEqual(serveWrites(spawner.commands), [
        ["serve", "--bg", "--https=10010", "http://127.0.0.1:3773"],
      ]);
    }).pipe(Effect.provide(Layer.merge(spawner.layer, http.layer)));
  });

  it.effect("adopts a mapping that already points at this server", () => {
    const spawner = spawnerLayer(serveStatusJson(3773));
    const http = httpClientLayer(true);

    return Effect.gen(function* () {
      const owned = yield* acquireTailscaleServe({ localPort: 3773, servePort: 10010 });

      assert.deepEqual(owned, { localPort: 3773, servePort: 10010 });
      assert.deepEqual(serveWrites(spawner.commands), []);
      assert.deepEqual(http.probed, []);
    }).pipe(Effect.provide(Layer.merge(spawner.layer, http.layer)));
  });

  it.effect("removes the mapping on shutdown while it still points here", () => {
    const spawner = spawnerLayer(serveStatusJson(3773));

    return Effect.gen(function* () {
      yield* releaseTailscaleServe({ localPort: 3773, servePort: 10010 });

      assert.deepEqual(
        spawner.commands.filter((args) => args.includes("off")),
        [["serve", "--https=10010", "off"]],
      );
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("leaves a mapping another server has taken over", () => {
    const spawner = spawnerLayer(serveStatusJson(3775));

    return Effect.gen(function* () {
      yield* releaseTailscaleServe({ localPort: 3773, servePort: 10010 });

      assert.deepEqual(
        spawner.commands.filter((args) => args.includes("off")),
        [],
      );
    }).pipe(Effect.provide(spawner.layer));
  });
});
