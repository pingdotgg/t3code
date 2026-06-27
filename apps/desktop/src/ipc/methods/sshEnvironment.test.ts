import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
} from "./sshEnvironment.ts";

const isSshHttpBridgeError = Schema.is(SshHttpBridgeError);

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
      assert.equal(isSshHttpBridgeError(error.cause), false);
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
