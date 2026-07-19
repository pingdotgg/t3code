import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  acquireSshPortForward,
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
  releaseSshPortForward,
} from "./sshEnvironment.ts";
import { DesktopSshEnvironment } from "../../ssh/DesktopSshEnvironment.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function makeHttpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("SSH environment IPC", () => {
  it.effect("acquires and releases SSH port-forward leases", () => {
    const calls: unknown[] = [];
    const target = {
      alias: "devbox",
      hostname: "devbox.example.test",
      username: "developer",
      port: 22,
    } as const;
    const layer = Layer.succeed(
      DesktopSshEnvironment,
      DesktopSshEnvironment.of({
        discoverHosts: () => Effect.succeed([]),
        ensureEnvironment: () => Effect.die("unused"),
        disconnectEnvironment: () => Effect.die("unused"),
        acquirePortForward: (receivedTarget, remotePort) =>
          Effect.sync(() => {
            calls.push([receivedTarget, remotePort]);
            return { leaseId: "lease-1", localPort: 42_173, remotePort };
          }),
        releasePortForward: (leaseId) => Effect.sync(() => void calls.push(leaseId)),
      }),
    );

    return Effect.gen(function* () {
      const acquired = yield* acquireSshPortForward.handler({ target, remotePort: 5173 });
      assert.deepEqual(acquired, {
        leaseId: "lease-1",
        localPort: 42_173,
        remotePort: 5173,
      });
      yield* releaseSshPortForward.handler({ leaseId: "lease-1" });
      assert.deepEqual(calls, [[target, 5173], "lease-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches and decodes the remote environment descriptor", () => {
    const requestUrls: string[] = [];
    const layer = makeHttpClientLayer((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);
        return jsonResponse(request, {
          environmentId: "remote-env",
          label: "Remote Devbox",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.2.3",
          capabilities: { repositoryIdentity: true },
        });
      }),
    );

    return Effect.gen(function* () {
      const descriptor = yield* fetchSshEnvironmentDescriptor.handler({
        httpBaseUrl: "http://127.0.0.1:41773/",
      });

      assert.deepEqual(descriptor, {
        environmentId: "remote-env",
        label: "Remote Devbox",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1.2.3",
        capabilities: { repositoryIdentity: true },
      });
      assert.deepEqual(requestUrls, ["http://127.0.0.1:41773/.well-known/t3/environment"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("wraps schema decode failures in a typed request error", () => {
    const layer = makeHttpClientLayer((request) =>
      Effect.succeed(jsonResponse(request, { environmentId: "remote-env" })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://127.0.0.1:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.equal(error.operation, "fetch-environment-descriptor");
      assert.equal(error.cause instanceof SshHttpBridgeError, false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = makeHttpClientLayer((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});
