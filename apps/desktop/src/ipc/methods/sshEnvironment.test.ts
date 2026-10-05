import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError, SshPasswordPromptError, SshReadinessError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  acquireSshPortForward,
  releaseSshPortForward,
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
} from "./sshEnvironment.ts";

import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";

const forwardTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};
const forwardLayer = (
  acquire: DesktopSshEnvironment.DesktopSshEnvironment["Service"]["acquirePortForward"],
  releases: string[] = [],
) =>
  Layer.succeed(
    DesktopSshEnvironment.DesktopSshEnvironment,
    DesktopSshEnvironment.DesktopSshEnvironment.of({
      discoverHosts: () => Effect.die("unused"),
      resolveHost: () => Effect.die("unused"),
      ensureEnvironment: () => Effect.die("unused"),
      disconnectEnvironment: () => Effect.die("unused"),
      acquirePortForward: acquire,
      releasePortForward: (leaseId) =>
        Effect.sync(() => {
          releases.push(leaseId);
        }),
    }),
  );

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
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
  it.effect("acquires distinct leases and passes repeated releases through", () => {
    let count = 0;
    const releases: string[] = [];
    const layer = forwardLayer(
      (target, port) =>
        Effect.sync(() => {
          assert.deepEqual(target, forwardTarget);
          assert.equal(port, 5173);
          return { leaseId: `lease-${++count}`, localPort: 41773 };
        }),
      releases,
    );
    return Effect.gen(function* () {
      assert.deepEqual(
        yield* acquireSshPortForward.handler({ target: forwardTarget, remotePort: 5173 }),
        { leaseId: "lease-1", localPort: 41773 },
      );
      assert.deepEqual(
        yield* acquireSshPortForward.handler({ target: forwardTarget, remotePort: 5173 }),
        { leaseId: "lease-2", localPort: 41773 },
      );
      yield* releaseSshPortForward.handler({ leaseId: "lease-1" });
      yield* releaseSshPortForward.handler({ leaseId: "lease-1" });
      assert.deepEqual(releases, ["lease-1", "lease-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns the same prompt-cancellation envelope as ensure", () => {
    const layer = forwardLayer(() =>
      Effect.fail(
        new SshPasswordPromptError({
          message: "SSH authentication cancelled for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptCancelledError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
    );
    return Effect.gen(function* () {
      assert.deepEqual(
        yield* acquireSshPortForward.handler({ target: forwardTarget, remotePort: 5173 }),
        {
          type: "ssh-password-prompt-cancelled",
          message: "SSH authentication cancelled for devbox.",
        },
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not disguise startup failures as cancellation", () => {
    const layer = forwardLayer(() =>
      Effect.fail(new SshReadinessError({ message: "Forward failed." })),
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        acquireSshPortForward.handler({ target: forwardTarget, remotePort: 5173 }),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        assert.isTrue(Option.isSome(error));
        if (Option.isSome(error)) assert.instanceOf(error.value, SshReadinessError);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid remote ports before calling the manager", () => {
    const layer = forwardLayer(() => Effect.die("invalid port reached manager"));
    return Effect.gen(function* () {
      for (const remotePort of [0, -1, 65536, 5173.5, "5173"]) {
        const exit = yield* Effect.exit(
          acquireSshPortForward.handler({ target: forwardTarget, remotePort }),
        );
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) assert.isFalse(Cause.hasDies(exit.cause));
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches and decodes the remote environment descriptor", () => {
    const requestUrls: string[] = [];
    const layer = layerHttpClient((request) =>
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
    const layer = layerHttpClient((request) =>
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
    const layer = layerHttpClient((request) =>
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
