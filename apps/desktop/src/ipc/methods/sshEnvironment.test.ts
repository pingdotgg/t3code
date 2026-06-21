import { assert, describe, it } from "@effect/vitest";
import {
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshPasswordPromptCancellationError,
} from "@t3tools/contracts";
import {
  SshCommandSpawnError,
  SshHttpBridgeError,
  SshPasswordPromptWindowClosedError,
} from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  DesktopSshEnvironmentRequestError,
  disconnectSshEnvironment,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
} from "./sshEnvironment.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";

const decodeDesktopSshEnvironmentEnsureResult = Schema.decodeUnknownEffect(
  DesktopSshEnvironmentEnsureResultSchema,
);

const isSshHttpBridgeError = Schema.is(SshHttpBridgeError);
const isDesktopSshEnvironmentRequestError = Schema.is(DesktopSshEnvironmentRequestError);

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
  it.effect("encodes password prompt cancellations with structured context and their cause", () => {
    const promptCause = new DesktopSshPasswordPrompts.DesktopSshPromptWindowClosedError({
      requestId: "prompt-1",
      destination: "developer@devbox.example.test",
    });
    const cause = new SshPasswordPromptWindowClosedError({
      destination: promptCause.destination,
      cause: promptCause,
    });
    const layer = Layer.succeed(
      DesktopSshEnvironment.DesktopSshEnvironment,
      DesktopSshEnvironment.DesktopSshEnvironment.of({
        discoverHosts: () => Effect.die("unexpected host discovery"),
        ensureEnvironment: () => Effect.fail(cause),
        disconnectEnvironment: () => Effect.die("unexpected disconnect"),
      }),
    );

    return Effect.gen(function* () {
      const encoded = yield* ensureSshEnvironment.handler({
        target: {
          alias: "devbox",
          hostname: "devbox.example.test",
          username: "developer",
          port: 22,
        },
      });
      const error = yield* decodeDesktopSshEnvironmentEnsureResult(encoded);

      assert.instanceOf(error, DesktopSshPasswordPromptCancellationError);
      assert.equal(error.reason, "window-closed");
      assert.equal(error.requestId, "prompt-1");
      assert.equal(error.destination, "developer@devbox.example.test");
      assert.instanceOf(error.cause, Error);
      assert.instanceOf(error.cause.cause, Error);
    }).pipe(Effect.provide(layer));
  });

  it.effect("preserves structural SSH errors and exact causes at the IPC boundary", () => {
    const cause = new Error("ssh executable was not found");
    const structured = new SshCommandSpawnError({
      command: "ssh",
      argumentCount: 0,
      target: "devbox",
      cause,
    });
    const target = {
      alias: "devbox",
      hostname: "devbox.example.test",
      username: "developer",
      port: 22,
    };
    const layer = Layer.succeed(
      DesktopSshEnvironment.DesktopSshEnvironment,
      DesktopSshEnvironment.DesktopSshEnvironment.of({
        discoverHosts: () => Effect.die("unexpected host discovery"),
        ensureEnvironment: () => Effect.fail(structured),
        disconnectEnvironment: () => Effect.fail(structured),
      }),
    );

    return Effect.gen(function* () {
      const exits = yield* Effect.all([
        Effect.exit(ensureSshEnvironment.handler({ target })),
        Effect.exit(disconnectSshEnvironment.handler(target)),
      ]);
      for (const exit of exits) {
        assert(Exit.isFailure(exit));
        const failure = Cause.findErrorOption(exit.cause);
        assert(Option.isSome(failure));
        assert.strictEqual(failure.value, structured);
      }
      assert.equal(structured.message, "Failed to spawn SSH command for devbox.");
      assert.strictEqual(structured.cause, cause);
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

      assert.isTrue(isDesktopSshEnvironmentRequestError(error));
      if (!isDesktopSshEnvironmentRequestError(error)) return;
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

      assert.isTrue(isDesktopSshEnvironmentRequestError(error));
      if (!isDesktopSshEnvironmentRequestError(error)) return;
      assert.equal(isSshHttpBridgeError(error.cause), true);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});
