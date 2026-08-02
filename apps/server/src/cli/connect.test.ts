import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";

import {
  acquireRelayClientForLink,
  authorizeCliWith,
  cloudConnectionStatus,
  cloudConfigurationError,
  completeCloudDisconnect,
  executeCloudDisconnect,
  formatHeadlessAuthorizationPrompt,
  isHeadlessConnectEnvironment,
  readPreferredCloudRuntimeStateWith,
  relayUnlinkResultFromStatus,
  reportCloudDisconnectResults,
} from "./connect.ts";
import { recoverServiceOnboardingOffer } from "./service.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { ServerConfig } from "../config.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";

it("distinguishes durable Connect status states without treating stale link metadata as online", () => {
  assert.equal(
    cloudConnectionStatus({
      desired: false,
      authenticated: false,
      linked: false,
      endpointRuntime: { status: "not-running" },
    }),
    "logged-out",
  );
  assert.equal(
    cloudConnectionStatus({
      desired: false,
      authenticated: true,
      linked: true,
      endpointRuntime: { status: "running", providerKind: "cloudflare_tunnel", pid: 1 },
    }),
    "authenticated-disabled",
  );
  assert.equal(
    cloudConnectionStatus({
      desired: true,
      authenticated: true,
      linked: false,
      endpointRuntime: { status: "not-running" },
    }),
    "link-pending",
  );
  assert.equal(
    cloudConnectionStatus({
      desired: true,
      authenticated: true,
      linked: true,
      endpointRuntime: { status: "not-running" },
    }),
    "linked-offline",
  );
  assert.equal(
    cloudConnectionStatus({
      desired: true,
      authenticated: true,
      linked: true,
      endpointRuntime: { status: "starting", providerKind: "cloudflare_tunnel", pid: 1 },
    }),
    "linked-offline",
  );
  assert.equal(
    cloudConnectionStatus({
      desired: true,
      authenticated: true,
      linked: true,
      endpointRuntime: { status: "running", providerKind: "cloudflare_tunnel", pid: 1 },
    }),
    "linked-online",
  );
});

it("permits credential-only login without a relay URL", () => {
  const oauthOnly = {
    hasCliOAuthConfig: true,
    hasPublicConfig: false,
  };

  assert.isUndefined(cloudConfigurationError("oauth", oauthOnly));
  assert.equal(
    cloudConfigurationError("full", oauthOnly),
    "T3 Connect is not configured. Set T3CODE_RELAY_URL, T3CODE_CLERK_PUBLISHABLE_KEY, and T3CODE_CLERK_CLI_OAUTH_CLIENT_ID.",
  );
});

it.effect("keeps successful Connect setup successful when background setup validation fails", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new Error("invalid T3CODE_PORT")),
    );
    assert.isFalse(result);
  }),
);

it("prefers service-instance runtime discovery over shared foreground state", async () => {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return;
  const userId = process.getuid();
  const baseDir = await mkdtemp(join(tmpdir(), "t3-connect-service-state-"));
  try {
    const effect = Effect.gen(function* () {
      const config = yield* ServerConfig;
      const canonicalBaseDir = yield* Effect.promise(() =>
        BootService.liveServiceHost.canonicalize(baseDir),
      );
      const serviceStatePath = BootService.servicePaths({
        homeDir: homedir(),
        canonicalBaseDir,
        userId,
      }).runtimeStatePath;
      const state = (pid: number, port: number) => ({
        version: 1 as const,
        pid,
        port,
        origin: `http://127.0.0.1:${port}`,
        startedAt: new Date(0).toISOString(),
      });
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: state(process.pid, 3773),
      });
      yield* persistServerRuntimeState({
        path: serviceStatePath,
        state: state(process.pid, 3774),
      });

      assert.equal(
        Option.getOrThrow(yield* readPreferredCloudRuntimeStateWith(async () => true)).port,
        3774,
      );
      assert.equal(
        Option.getOrThrow(yield* readPreferredCloudRuntimeStateWith(async () => false)).port,
        3773,
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
    await Effect.runPromise(effect);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("keeps status and disconnect commands usable when Connect is not configured", () => {
  const unconfigured = {
    hasCliOAuthConfig: false,
    hasPublicConfig: false,
  };

  assert.isUndefined(cloudConfigurationError(undefined, unconfigured));
});

it("treats a missing relay environment as an idempotent unlink result", () => {
  assert.deepEqual(relayUnlinkResultFromStatus(404), { status: "not-linked" });
  assert.isUndefined(relayUnlinkResultFromStatus(503));
});

it.effect("disables locally before tunnel stop, relay cleanup, metadata cleanup, and logout", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const run = () =>
      executeCloudDisconnect({
        disableLocal: Effect.sync(() => {
          operations.push("disable");
        }),
        stopLiveTunnel: Effect.sync(() => {
          operations.push("stop");
          return { status: "succeeded" as const };
        }),
        revokeRelayEnvironment: Effect.sync(() => {
          operations.push("revoke");
          return { status: "not-linked" as const };
        }),
        clearMetadata: Effect.sync(() => {
          operations.push("metadata");
        }),
        clearAuthorization: Effect.sync(() => {
          operations.push("authorization");
        }),
      });

    yield* run();
    yield* run();

    assert.deepEqual(operations, [
      "disable",
      "stop",
      "revoke",
      "metadata",
      "authorization",
      "disable",
      "stop",
      "revoke",
      "metadata",
      "authorization",
    ]);
  }),
);

it.effect("retains disablement when relay and local cleanup fail", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const result = yield* executeCloudDisconnect({
      disableLocal: Effect.sync(() => {
        operations.push("disable");
      }),
      stopLiveTunnel: Effect.succeed({ status: "not-running" as const }),
      revokeRelayEnvironment: Effect.fail(new Error("relay unavailable")),
      clearMetadata: Effect.fail(new Error("secret store unavailable")),
      clearAuthorization: Effect.fail(new Error("credential store unavailable")),
    });

    assert.deepEqual(operations, ["disable"]);
    assert.isTrue(Exit.isFailure(result.relayResult));
    assert.isTrue(Exit.isFailure(result.metadataResult));
    assert.isTrue(Exit.isFailure(result.authorizationResult!));
  }),
);

it.effect("continues cleanup when live tunnel teardown fails through its error channel", () =>
  Effect.gen(function* () {
    const operations: string[] = [];
    const result = yield* executeCloudDisconnect({
      disableLocal: Effect.sync(() => {
        operations.push("disable");
      }),
      stopLiveTunnel: Effect.fail(new Error("live tunnel teardown failed")),
      revokeRelayEnvironment: Effect.sync(() => {
        operations.push("revoke");
        return { status: "not-linked" as const };
      }),
      clearMetadata: Effect.sync(() => {
        operations.push("metadata");
      }),
      clearAuthorization: Effect.sync(() => {
        operations.push("authorization");
      }),
    });

    assert.equal(result.liveResult.status, "failed");
    assert.deepEqual(operations, ["disable", "revoke", "metadata", "authorization"]);
    yield* Effect.flip(completeCloudDisconnect(result));
  }),
);

it.effect("fails unlink and logout after live teardown failure without skipping cleanup", () =>
  Effect.gen(function* () {
    for (const clearAuthorization of [false, true]) {
      const operations: string[] = [];
      let desired = true;
      const result = yield* executeCloudDisconnect({
        disableLocal: Effect.sync(() => {
          desired = false;
          operations.push("disable");
        }),
        stopLiveTunnel: Effect.sync(() => {
          operations.push("stop");
          return { status: "failed" as const, cause: Cause.die("tunnel did not stop") };
        }),
        revokeRelayEnvironment: Effect.sync(() => {
          operations.push("revoke");
          return { status: "not-linked" as const };
        }),
        clearMetadata: Effect.sync(() => {
          operations.push("metadata");
        }),
        ...(clearAuthorization
          ? {
              clearAuthorization: Effect.sync(() => {
                operations.push("authorization");
              }),
            }
          : {}),
      });

      const error = yield* Effect.flip(completeCloudDisconnect(result));
      assert.equal(
        error.message,
        "T3 Connect is disabled locally, but the running server could not stop its tunnel. Restart that server to stop the connector.",
      );
      assert.isFalse(desired);
      assert.deepEqual(
        operations,
        clearAuthorization
          ? ["disable", "stop", "revoke", "metadata", "authorization"]
          : ["disable", "stop", "revoke", "metadata"],
      );
    }
  }),
);

it("selects out-of-band authorization for SSH sessions and formats its prompt", () => {
  assert.isTrue(isHeadlessConnectEnvironment({ SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2" }));
  assert.isTrue(isHeadlessConnectEnvironment({ SSH_TTY: "/dev/pts/1" }));
  assert.isFalse(isHeadlessConnectEnvironment({}));
  assert.equal(
    formatHeadlessAuthorizationPrompt("https://app.example.test/connect#state=abc"),
    [
      "Headless authorization",
      "Open this URL on a device with a browser:",
      "  https://app.example.test/connect#state=abc",
      "",
      "After signing in, return here and enter the code shown in your browser.",
    ].join("\n"),
  );
});

const token = (identity: string): CliTokenManager.PersistedToken => ({
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAtEpochMs: Date.now() + 60_000,
  identity,
});

it.effect("reuses a stored headless credential without starting authorization", () =>
  Effect.gen(function* () {
    let loginCalls = 0;
    const identity = yield* authorizeCliWith(
      { headless: true },
      {
        get: Effect.die("unexpected browser login"),
        getExisting: Effect.succeed(Option.some(token("stored@example.test"))),
        hasCredential: Effect.succeed(true),
        store: () => Effect.die("unexpected token store"),
        clear: Effect.void,
      },
      Effect.sync(() => {
        loginCalls += 1;
        return { token: token("new@example.test"), identity: "new@example.test" };
      }),
    );

    assert.equal(identity, "stored@example.test");
    assert.equal(loginCalls, 0);
  }),
);

it.effect("falls back to headless authorization after refresh failure and stores the token", () =>
  Effect.gen(function* () {
    const stored: CliTokenManager.PersistedToken[] = [];
    const replacement = token("replacement@example.test");
    const identity = yield* authorizeCliWith(
      { headless: true },
      {
        get: Effect.die("unexpected browser login"),
        getExisting: Effect.fail(
          new CliTokenManager.CloudCliCredentialRefreshError({ cause: "revoked" }),
        ),
        hasCredential: Effect.succeed(true),
        store: (value) =>
          Effect.sync(() => {
            stored.push(value);
          }),
        clear: Effect.void,
      },
      Effect.succeed({ token: replacement, identity: "replacement@example.test" }),
    );

    assert.equal(identity, "replacement@example.test");
    assert.deepEqual(stored, [replacement]);
  }),
);

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.effect("installs the relay client after the user accepts the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const progress: Array<string> = [];
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: (report) =>
          report({ type: "progress", stage: "downloading" }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                installCalls += 1;
                return managedExecutable;
              }),
            ),
          ),
      },
      () => Effect.succeed(true),
      (event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(installCalls, 1);
    assert.deepEqual(progress, ["downloading"]);
  }),
);

it.effect("reuses an available relay client executable without prompting", () =>
  Effect.gen(function* () {
    let promptCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed(managedExecutable),
        install: Effect.die("unexpected install"),
        installWithProgress: () => Effect.die("unexpected install"),
      },
      () =>
        Effect.sync(() => {
          promptCalls += 1;
          return false;
        }),
      () => Effect.void,
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(promptCalls, 0);
  }),
);

it.effect("keeps disconnect causes in structured logs and out of console warnings", () => {
  const warnings: ReadonlyArray<unknown>[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const testConsole = {
    ...globalThis.console,
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args);
    },
  } satisfies Console.Console;
  const logger = Logger.make(({ fiber }) => {
    logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  const liveFailure = "live unlink private diagnostic";
  const relayFailure = "relay revoke private diagnostic";

  return reportCloudDisconnectResults({
    clearAuthorization: true,
    liveResult: {
      status: "failed",
      cause: Cause.fail(new Error(liveFailure)),
    },
    relayResult: Exit.failCause(Cause.die(new Error(relayFailure))),
  }).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.lengthOf(warnings, 2);
        const warningText = warnings.flat().map(String).join("\n");
        assert.include(warningText, "running server could not stop its tunnel");
        assert.include(warningText, "Could not revoke the relay-side environment record");
        assert.notInclude(warningText, liveFailure);
        assert.notInclude(warningText, relayFailure);
        assert.deepEqual(
          logs.map(({ operation, clearAuthorization }) => ({ operation, clearAuthorization })),
          [
            { operation: "live-server-unlink", clearAuthorization: true },
            { operation: "relay-environment-unlink", clearAuthorization: true },
          ],
        );
        const loggedCauses = logs.map((log) => String(log.cause)).join("\n");
        assert.include(loggedCauses, liveFailure);
        assert.include(loggedCauses, relayFailure);
      }),
    ),
  );
});

it.effect("explains that an unauthenticated unlink may leave a remote record", () => {
  const warnings: ReadonlyArray<unknown>[] = [];
  const testConsole = {
    ...globalThis.console,
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args);
    },
  } satisfies Console.Console;

  return reportCloudDisconnectResults({
    clearAuthorization: false,
    liveResult: { status: "not-running" },
    relayResult: Exit.succeed({ status: "not-authenticated" }),
  }).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.include(
          warnings.flat().map(String).join("\n"),
          "Sign in and run `t3 connect unlink`",
        );
      }),
    ),
  );
});
