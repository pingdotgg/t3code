import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { SshConnectionProfile } from "../connection/catalog.ts";
import { ConnectionProfileStore } from "../connection/profileStore.ts";
import { SshEnvironmentGateway } from "../platform/capabilities.ts";
import { EnvironmentPortRouter } from "./router.ts";

const environmentId = EnvironmentId.make("environment-1");
const sshTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
} as const;

const primaryConnection = (httpBaseUrl: string): PreparedConnection => ({
  environmentId,
  label: "Environment",
  httpBaseUrl,
  socketUrl: "ws://example.test",
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "Environment",
    httpBaseUrl,
    wsBaseUrl: "ws://example.test",
  }),
});

const sshConnection: PreparedConnection = {
  environmentId,
  label: "SSH environment",
  httpBaseUrl: "http://127.0.0.1:3773",
  socketUrl: "ws://127.0.0.1:3773",
  httpAuthorization: null,
  target: new SshConnectionTarget({
    environmentId,
    label: "SSH environment",
    connectionId: "ssh:environment-1",
  }),
};

const sshProfile = new SshConnectionProfile({
  connectionId: "ssh:environment-1",
  environmentId,
  label: "SSH environment",
  target: sshTarget,
});

const routerLayer = (options?: {
  readonly profile?: SshConnectionProfile;
  readonly forwardPort?: SshEnvironmentGateway["Service"]["forwardPort"];
}) =>
  EnvironmentPortRouter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ConnectionProfileStore,
          ConnectionProfileStore.of({
            get: () => Effect.succeed(Option.fromUndefinedOr(options?.profile)),
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
        Layer.succeed(
          SshEnvironmentGateway,
          SshEnvironmentGateway.of({
            provision: () => Effect.die("unused"),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.void,
            forwardPort: options?.forwardPort ?? (() => Effect.die("unused")),
          }),
        ),
      ),
    ),
  );

describe("EnvironmentPortRouter", () => {
  it.effect("maps environment ports onto a private network host", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://192.168.1.25:3773"),
        target: { kind: "environment-port", port: 5173, path: "/dashboard" },
      });
      assert.deepStrictEqual(resolution, {
        requestedUrl: "http://localhost:5173/dashboard",
        resolvedUrl: "http://192.168.1.25:5173/dashboard",
        resolutionKind: "direct-private-network",
        environmentId,
      });
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("keeps localhost navigation local for a local environment", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://127.0.0.1:3773"),
        target: { kind: "url", url: "localhost:3000/app" },
      });
      assert.deepStrictEqual(resolution, {
        requestedUrl: "localhost:3000/app",
        resolvedUrl: "localhost:3000/app",
        resolutionKind: "direct",
        environmentId,
      });
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("maps localhost URLs onto remote Tailscale hosts", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://100.65.180.100:3773"),
        target: {
          kind: "url",
          url: "http://localhost:5173/dashboard?mode=test#results",
        },
      });
      assert.equal(
        resolution.resolvedUrl,
        "http://100.65.180.100:5173/dashboard?mode=test#results",
      );
      assert.equal(resolution.resolutionKind, "direct-private-network");
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("preserves credentials when mapping onto private IPv6 hosts", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://[fd7a:115c:a1e0::53]:3773"),
        target: {
          kind: "url",
          url: "http://user:p%40ss@localhost:5173/dashboard?mode=test#results",
        },
      });
      assert.equal(
        resolution.resolvedUrl,
        "http://user:p%40ss@[fd7a:115c:a1e0::53]:5173/dashboard?mode=test#results",
      );
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("maps wildcard loopback URLs back to localhost for a local environment", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://localhost:3773"),
        target: { kind: "url", url: "http://0.0.0.0:3000/app" },
      });
      assert.equal(resolution.resolvedUrl, "http://localhost:3000/app");
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("recognizes the full IPv4 loopback range on environment endpoints", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://127.0.0.2:3773"),
        target: { kind: "url", url: "http://localhost:3000/app" },
      });
      assert.equal(resolution.resolvedUrl, "http://localhost:3000/app");
      assert.equal(resolution.resolutionKind, "direct");
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("preserves malformed input for the preview navigation error path", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: primaryConnection("http://127.0.0.1:3773"),
        target: { kind: "url", url: "   " },
      });
      assert.equal(resolution.resolvedUrl, "   ");
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("acquires and releases an SSH forward within the caller scope", () => {
    let releases = 0;
    const forwardPort: SshEnvironmentGateway["Service"]["forwardPort"] = (input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          assert.deepStrictEqual(input, { target: sshTarget, remotePort: 5173 });
          return { localPort: 42_173 };
        }),
        () => Effect.sync(() => releases++),
      );

    return Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* Effect.scoped(
        router.acquire({
          connection: sshConnection,
          target: {
            kind: "url",
            url: "http://user:p%40ss@localhost:5173/dashboard?mode=test#results",
          },
        }),
      );
      assert.equal(
        resolution.resolvedUrl,
        "http://user:p%40ss@127.0.0.1:42173/dashboard?mode=test#results",
      );
      assert.equal(resolution.resolutionKind, "ssh-forward");
      assert.equal(releases, 1);
    }).pipe(Effect.provide(routerLayer({ profile: sshProfile, forwardPort })));
  });

  it.effect("reports T3 Connect environment ports as unsupported", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const exit = yield* Effect.exit(
        router.acquire({
          connection: {
            ...primaryConnection("https://relay.example.test"),
            target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
          },
          target: { kind: "environment-port", port: 5173 },
        }),
      );
      assert(exit._tag === "Failure");
      assert.include(String(exit.cause), "T3 Connect preview forwarding is not supported yet");
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );

  it.effect("leaves ordinary public URLs outside environment routing", () =>
    Effect.gen(function* () {
      const router = yield* EnvironmentPortRouter;
      const resolution = yield* router.acquire({
        connection: sshConnection,
        target: { kind: "url", url: "https://example.com/app" },
      });
      assert.equal(resolution.resolvedUrl, "https://example.com/app");
      assert.equal(resolution.resolutionKind, "direct");
    }).pipe(Effect.provide(routerLayer()), Effect.scoped),
  );
});
