// @effect-diagnostics nodeBuiltinImport:off - integration test owns a loopback HTTP server.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { isLivePersistedServerRuntimeState } from "./runningServer.ts";

const descriptor = {
  environmentId: "running-server-test",
  label: "running-server-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

const state = (origin: string, pid = process.pid): PersistedServerRuntimeState => ({
  version: 1,
  pid,
  port: Number(new URL(origin).port),
  origin,
  startedAt: "2026-08-01T00:00:00.000Z",
});

const withServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(descriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("live persisted server validation", () => {
  it.effect("accepts a live pid whose origin serves a T3 descriptor", () =>
    withServer((origin) =>
      Effect.gen(function* () {
        assert.isTrue(yield* isLivePersistedServerRuntimeState(state(origin)));
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("rejects a dead pid even when the origin was reused by T3", () =>
    withServer((origin) =>
      Effect.gen(function* () {
        assert.isFalse(yield* isLivePersistedServerRuntimeState(state(origin, 4_194_305)));
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("rejects a live pid when the recorded origin is unreachable", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* isLivePersistedServerRuntimeState(state("http://127.0.0.1:1")));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
