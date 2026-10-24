import {
  bootstrapRemoteBearerSession,
  issueRemoteWebSocketTicket,
} from "@t3tools/client-runtime/authorization";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as PrimaryTarget from "../environments/primary/target.ts";
import { afterEach, vi } from "vite-plus/test";
import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  EnvironmentRegistry,
  ConnectionDriver,
  mapRemoteEnvironmentError,
  Connectivity,
  ProfileStore,
  Wakeups,
  CredentialStore,
  type ConnectionCredential,
  type PlatformConnectionRegistration,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  layer,
  layerPlatformConnectionSource,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  nextRejectedSecondaryBootstrap,
  primaryRegistrationToRetainAfterTopologyRead,
  prepareDesktopSshEnvironment,
  provisionDesktopSshEnvironment,
  secondaryRegistrationsToRetainAfterTopologyRead,
} from "./platform.ts";
import { APP_VERSION } from "../branding.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

const SSH_BOOTSTRAP = {
  target: TARGET,
  httpBaseUrl: "http://127.0.0.1:3201/",
  wsBaseUrl: "ws://127.0.0.1:3201/",
  pairingToken: "abandoned-token",
};

function pendingSetup() {
  let resolve!: (bootstrap: DesktopSshEnvironmentBootstrap) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<DesktopSshEnvironmentBootstrap>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeBridge(
  calls: string[],
  options?: {
    readonly failDescriptor?: boolean;
    readonly savedTokenRejected?: boolean;
    readonly savedTokenPermissions?: ReadonlyArray<string>;
  },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (
      target: DesktopSshEnvironmentTarget,
      ensureOptions?: { issuePairingToken?: boolean },
    ) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: ensureOptions?.issuePairingToken === true ? "pairing-token" : null,
      };
    },
    disconnectSshEnvironment: async () => {
      calls.push("disconnect");
    },
    fetchSshSessionState: async () => {
      calls.push("session");
      return {
        authenticated: options?.savedTokenRejected !== true,
        permissions: options?.savedTokenPermissions ?? AuthStandardClientScopes,
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        TARGET,
        EnvironmentId.make("some-other-machine"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("exchanges one setup credential after repeated interrupted provisions", () =>
    Effect.gen(function* () {
      const bridge = makeBridge([]);
      const setup = pendingSetup();
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValue(setup.promise);
      const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const interrupted = yield* Effect.forkChild(
          provisionDesktopSshEnvironment(bridge, TARGET),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(interrupted);
      }

      const retry = yield* Effect.forkChild(provisionDesktopSshEnvironment(bridge, TARGET), {
        startImmediately: true,
      });
      setup.resolve(SSH_BOOTSTRAP);
      const provisioned = yield* Fiber.join(retry);

      expect(provisioned.bearerToken).toBe("bearer-token");
      expect(ensure).toHaveBeenCalledExactlyOnceWith(TARGET, { issuePairingToken: true });
      expect(exchange).toHaveBeenCalledExactlyOnceWith(
        SSH_BOOTSTRAP.httpBaseUrl,
        "abandoned-token",
      );
    }),
  );

  it.effect("starts fresh after an abandoned setup settles in success or failure", () =>
    Effect.gen(function* () {
      for (const outcome of ["success", "failure"]) {
        const bridge = makeBridge([]);
        const setup = pendingSetup();
        const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValueOnce(setup.promise);
        const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
        const interrupted = yield* Effect.forkChild(
          provisionDesktopSshEnvironment(bridge, TARGET),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(interrupted);
        if (outcome === "success") setup.resolve(SSH_BOOTSTRAP);
        else setup.reject(new Error("remote launch failed"));
        yield* Effect.promise(() =>
          setup.promise.then(
            () => undefined,
            () => undefined,
          ),
        );

        const provisioned = yield* provisionDesktopSshEnvironment(bridge, TARGET);

        expect(provisioned.bearerToken).toBe("bearer-token");
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(exchange).toHaveBeenCalledExactlyOnceWith(
          SSH_BOOTSTRAP.httpBaseUrl,
          "pairing-token",
        );
      }
    }),
  );

  it.effect("disconnect invalidates unfinished setup even before provision is interrupted", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = makeBridge(calls);
      const setup = pendingSetup();
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValueOnce(setup.promise);
      const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
      vi.stubGlobal("window", { desktopBridge: bridge });
      const ssh = yield* ClientCapabilities.SshEnvironmentGateway.pipe(Effect.provide(layer));
      const interrupted = yield* Effect.forkChild(ssh.provision(TARGET), {
        startImmediately: true,
      });
      yield* ssh.disconnect(TARGET);
      yield* Fiber.interrupt(interrupted);

      const retry = yield* Effect.forkChild(ssh.provision(TARGET), { startImmediately: true });
      setup.resolve(SSH_BOOTSTRAP);
      const provisioned = yield* Fiber.join(retry);

      expect(provisioned.bearerToken).toBe("bearer-token");
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(["disconnect", "ensure", "descriptor", "token"]);
      expect(exchange).toHaveBeenCalledExactlyOnceWith(SSH_BOOTSTRAP.httpBaseUrl, "pairing-token");
    }),
  );

  const failPairing = (serverVersion: string, message: string) => {
    const bridge = makeBridge([]);
    const fetchDescriptor = bridge.fetchSshEnvironmentDescriptor;
    vi.spyOn(bridge, "fetchSshEnvironmentDescriptor").mockImplementation(async (url) => ({
      ...(await fetchDescriptor(url)),
      serverVersion,
    }));
    vi.spyOn(bridge, "bootstrapSshBearerSession").mockRejectedValue(new Error(message));
    return provisionDesktopSshEnvironment(bridge, TARGET).pipe(Effect.flip);
  };
  const PAIRING_500 =
    "[ssh_http:500] SSH remote API request failed during bootstrap-bearer-session.";

  it.effect("blocks with both versions when a server on another build rejects pairing", () =>
    Effect.gen(function* () {
      const error = yield* failPairing("0.0.46-nightly.20261004.2652", PAIRING_500);

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error.detail).toContain("0.0.46-nightly.20261004.2652");
      expect(error.detail).toContain(APP_VERSION);
    }),
  );

  it.effect("keeps retrying pairing failures that are not a version mismatch", () =>
    Effect.gen(function* () {
      expect(yield* failPairing(APP_VERSION, PAIRING_500)).toBeInstanceOf(ConnectionTransientError);
      expect(
        yield* failPairing(
          "0.0.46-nightly.20261004.2652",
          "SSH remote API request failed during bootstrap-bearer-session.",
        ),
      ).toBeInstanceOf(ConnectionTransientError);
    }),
  );

  it.effect("reconnects with the saved token while it holds every standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const bridge = makeBridge(calls);
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment");
      const prepared = yield* prepareDesktopSshEnvironment(bridge, {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
        bearerToken: "saved-token",
      });

      expect(prepared.bearerToken).toBe("saved-token");
      expect(ensure).toHaveBeenCalledExactlyOnceWith(TARGET, { issuePairingToken: false });
      expect(calls).toEqual(["ensure", "descriptor", "session"]);
    }),
  );

  it.effect("pairs again when the host no longer accepts the saved token", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, { savedTokenRejected: true }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("pairs again when the saved token predates a standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, {
          savedTokenPermissions: ["orchestration:read", "orchestration:operate"],
        }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("stops before sending the saved token or pairing on a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* prepareDesktopSshEnvironment(makeBridge(calls), {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
        bearerToken: "saved-token",
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  // regression: #16273 a rejected desktop-local credential was retried every poll
  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });
});

const layerTestCredentials = Layer.effect(
  CredentialStore.ConnectionCredentialStore,
  Effect.gen(function* () {
    const stored = yield* Ref.make(new Map<string, ConnectionCredential>());
    const rejected = new Map<string, ConnectionCredential>();
    return CredentialStore.ConnectionCredentialStore.of({
      get: (id) =>
        Ref.get(stored).pipe(Effect.map((current) => Option.fromUndefinedOr(current.get(id)))),
      put: (id, credential) =>
        Ref.update(stored, (current) => new Map(current).set(id, credential)),
      wasRejected: (id, credential) =>
        Effect.sync(() => Equal.equals(rejected.get(id), credential)),
      removeIfMatches: (id, credential) =>
        Ref.update(stored, (current) => {
          if (!Equal.equals(current.get(id), credential)) return current;
          rejected.set(id, credential);
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      remove: (id) =>
        Ref.update(stored, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
    });
  }),
);

describe("desktop-local startup bearer exchange", () => {
  function fakeBootstrapEndpoint(
    beforeExchange?: (request: number) => Promise<void>,
    expiresInSeconds = 60,
  ) {
    const tokenRequests: string[] = [];
    const ticketRequests: Array<string | null> = [];
    let rejectExchange = false;
    let networkFailure = false;
    let currentBearer: string | undefined;
    let bootstrapToken = "bootstrap-token";
    let present = true;
    let host = "backend.example.test";
    vi.spyOn(PrimaryTarget, "readPrimaryEnvironmentTarget").mockReturnValue(null);
    vi.stubGlobal("window", {
      location: new URL("http://renderer.example.test/"),
      desktopBridge: {
        getLocalEnvironmentBootstraps: () =>
          present
            ? [
                {
                  id: "wsl:test",
                  label: "WSL test",
                  httpBaseUrl: `http://${host}/`,
                  wsBaseUrl: `ws://${host}/`,
                  bootstrapToken,
                },
              ]
            : [],
      },
    });
    vi.stubGlobal("navigator", { userAgent: "test", platform: "Linux", maxTouchPoints: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/.well-known/t3/environment") {
          return Response.json({
            environmentId: "desktop-secondary-test",
            label: "WSL test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          });
        }
        if (url.pathname === "/api/auth/websocket-ticket") {
          const authorization = new Headers(
            input instanceof Request ? input.headers : init?.headers,
          ).get("authorization");
          ticketRequests.push(authorization);
          if (authorization !== `Bearer ${currentBearer}`)
            return Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "revoked-session-test",
              },
              { status: 401 },
            );
          return Response.json({ ticket: "ws-ticket", expiresAt: "2026-10-21T12:05:00.000Z" });
        }
        if (url.pathname === "/oauth/token") {
          tokenRequests.push(url.href);
          const request = tokenRequests.length;
          await beforeExchange?.(request);
          if (networkFailure) throw new TypeError("Network unavailable");
          if (rejectExchange) {
            return Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "revoked-session-test",
              },
              { status: 401 },
            );
          }
          currentBearer = `bearer-${request}`;
          return Response.json({
            access_token: currentBearer,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: expiresInSeconds,
            scope: AuthStandardClientScopes.join(" "),
          });
        }
        throw new Error(`Unexpected endpoint: ${url.href}`);
      }),
    );
    return {
      tokenRequests,
      ticketRequests,
      move: () => {
        host = "restarted-backend.example.test";
      },
      rotate: () => {
        bootstrapToken = "rotated-bootstrap";
      },
      remove: () => {
        present = false;
      },
      revoke: () => {
        rejectExchange = true;
      },
      failNetwork: () => {
        networkFailure = true;
      },
      recover: () => {
        networkFailure = false;
        rejectExchange = false;
      },
    };
  }

  it.effect("exchanges again on the next poll after its bearer credential is invalidated", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(first).toHaveLength(1);
        const credentials = yield* CredentialStore.ConnectionCredentialStore;
        const registration = first[0]!;
        if (registration._tag !== "BearerConnectionRegistration")
          throw new Error("Expected bearer");
        yield* credentials.put(registration.target.connectionId, registration.credential);
        yield* credentials.removeIfMatches!(
          registration.target.connectionId,
          registration.credential,
        );
        const recovered = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(endpoint.tokenRequests).toHaveLength(2);
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).not.toEqual(first[0]);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect("retains a valid bearer and backs off when a rotated bootstrap grant is rejected", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        endpoint.rotate();
        endpoint.revoke();
        const rejected = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(rejected).toEqual(first);
        endpoint.recover();
        const backedOff = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(backedOff).toEqual(first);
        expect(endpoint.tokenRequests).toHaveLength(2);
        yield* TestClock.adjust("60 seconds");
        const recovered = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(endpoint.tokenRequests).toHaveLength(3);
        expect(recovered).not.toEqual(first);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect(
    "a stale bearer registration survives failed refreshes even if the registry restores its token",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          const target = first[0]!.target;
          if (target._tag !== "BearerConnectionTarget") throw new Error("Expected bearer");
          const credentials = yield* CredentialStore.ConnectionCredentialStore;
          const registration = first[0]!;
          if (registration._tag !== "BearerConnectionRegistration")
            throw new Error("Expected bearer");
          yield* credentials.put(target.connectionId, registration.credential);
          yield* credentials.removeIfMatches!(target.connectionId, registration.credential);
          endpoint.revoke();
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual(first);
          yield* credentials.put(target.connectionId, registration.credential);
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual(first);
          expect(endpoint.tokenRequests).toHaveLength(2);
          endpoint.recover();
          yield* TestClock.adjust("60 seconds");
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toHaveLength(1);
          expect(endpoint.tokenRequests).toHaveLength(3);
        }).pipe(
          Effect.provide(
            layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect("a failed exchange is cleared and retried after bootstrap rejection backoff", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      endpoint.revoke();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual([]);
        endpoint.recover();
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual([]);
        expect(endpoint.tokenRequests).toHaveLength(1);
        yield* TestClock.adjust("60 seconds");
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toHaveLength(1);
        expect(endpoint.tokenRequests).toHaveLength(2);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect.each(["recover", "network", "auth"] as const)(
    "recovers after a second runtime revokes the bearer without clearing drafts (refresh: %s)",
    (refresh) =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        const freshAttempt = yield* Deferred.make<string>();
        const cacheClears: string[] = [];
        const draftClears: string[] = [];
        const layerRegistry = EnvironmentRegistry.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Persistence.ConnectionTargetStore, {
                list: Effect.succeed([]),
                listDisabled: Effect.succeed([]),
              }),
              Layer.succeed(Persistence.ConnectionRegistrationStore, {
                register: () => Effect.void,
                setRoutes: () => Effect.void,
                remove: () => Effect.void,
                setEnabled: () => Effect.void,
              }),
              Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, {
                clear: (id) =>
                  Effect.sync(() => {
                    draftClears.push(id);
                  }),
              }),
              Layer.succeed(Persistence.EnvironmentCacheStore, {
                loadShell: () => Effect.succeedNone,
                saveShell: () => Effect.void,
                loadThread: () => Effect.succeedNone,
                saveThread: () => Effect.void,
                removeThread: () => Effect.void,
                loadServerConfig: () => Effect.succeedNone,
                saveServerConfig: () => Effect.void,
                loadVcsRefs: () => Effect.succeedNone,
                saveVcsRefs: () => Effect.void,
                removeVcsRefs: () => Effect.void,
                clearVcsRefs: () => Effect.void,
                clear: (id) =>
                  Effect.sync(() => {
                    cacheClears.push(id);
                  }),
              }),
              Layer.succeed(ProfileStore.ConnectionProfileStore, {
                get: () => Effect.succeedNone,
                put: () => Effect.void,
                remove: () => Effect.void,
              }),
              Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
                provision: () => Effect.never,
                prepare: () => Effect.never,
                disconnect: () => Effect.void,
              }),
              Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
              Wakeups.layer({ changes: Stream.never }),
              Layer.effect(
                ConnectionDriver,
                Effect.gen(function* () {
                  const credentials = yield* CredentialStore.ConnectionCredentialStore;
                  return ConnectionDriver.of({
                    connect: (entry) =>
                      Effect.gen(function* () {
                        if (entry.target._tag !== "BearerConnectionTarget")
                          return yield* Effect.never;
                        const credential = Option.getOrThrow(
                          yield* credentials.get(entry.target.connectionId),
                        );
                        yield* issueRemoteWebSocketTicket({
                          httpBaseUrl: "http://backend.example.test/",
                          bearerToken: credential.token,
                        }).pipe(
                          Effect.mapError(mapRemoteEnvironmentError),
                          Effect.provide(FetchHttpClient.layer),
                        );
                        yield* Deferred.succeed(freshAttempt, credential.token);
                        return yield* Effect.never;
                      }),
                    checkRoute: () => Effect.succeed("unchecked"),
                    preflight: () => Effect.succeed(false),
                  });
                }),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const credentials = yield* CredentialStore.ConnectionCredentialStore;
          const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          const target = first[0]!.target;
          if (target._tag !== "BearerConnectionTarget") throw new Error("Expected bearer");
          yield* TestClock.adjust("700 millis");
          yield* bootstrapRemoteBearerSession({
            httpBaseUrl: "http://backend.example.test/",
            credential: "bootstrap-token",
          }).pipe(Effect.provide(FetchHttpClient.layer));
          expect(endpoint.tokenRequests).toHaveLength(2);
          yield* registry.reconcilePlatform(first);
          yield* registry.stateChanges(target.environmentId).pipe(
            Stream.filter((state) => state.phase === "blocked"),
            Stream.runHead,
          );
          expect(yield* credentials.get(target.connectionId)).toEqual(Option.none());
          if (refresh !== "recover") {
            if (refresh === "network") endpoint.failNetwork();
            else endpoint.revoke();
            const retained = Option.getOrThrow(yield* Stream.runHead(source.registrations));
            expect(retained).toEqual(first);
            yield* registry.reconcilePlatform(retained);
            yield* TestClock.adjust("3 seconds");
            yield* registry.reconcilePlatform(retained);
            expect(endpoint.ticketRequests).toEqual(["Bearer bearer-1"]);
            expect(yield* credentials.get(target.connectionId)).toEqual(Option.none());
            expect(cacheClears).toEqual([]);
            expect(draftClears).toEqual([]);
            expect((yield* registry.state(target.environmentId)).phase).not.toBe("absent");
            endpoint.recover();
            if (refresh === "auth") yield* TestClock.adjust("60 seconds");
          }
          const next = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          yield* registry.reconcilePlatform(next);
          expect(yield* Deferred.await(freshAttempt)).toBe(
            refresh === "recover" ? "bearer-3" : "bearer-4",
          );
          expect(endpoint.tokenRequests).toHaveLength(refresh === "recover" ? 3 : 4);
          expect(cacheClears).toEqual([]);
          expect(draftClears).toEqual([]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layerRegistry, layerPlatformConnectionSource).pipe(
              Layer.provideMerge(layerTestCredentials),
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect(
    "missing credentials and failed persistence do not invalidate a healthy cached bearer",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const store = yield* CredentialStore.ConnectionCredentialStore;
          const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          const registration = first[0]!;
          if (registration._tag !== "BearerConnectionRegistration")
            throw new Error("Expected bearer");
          expect(
            yield* store
              .put(registration.target.connectionId, registration.credential)
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "ConnectionTransientError" });
          yield* TestClock.adjust("3 seconds");
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual(first);
          expect(endpoint.tokenRequests).toHaveLength(1);
        }).pipe(
          Effect.provide(
            layerPlatformConnectionSource.pipe(
              Layer.provideMerge(
                Layer.succeed(CredentialStore.ConnectionCredentialStore, {
                  get: () => Effect.succeedNone,
                  put: () =>
                    Effect.fail(
                      new ConnectionTransientError({
                        reason: "remote-unavailable",
                        detail: "Storage unavailable",
                      }),
                    ),
                  remove: () => Effect.void,
                }),
              ),
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect(
    "repeated fresh bearer rejections back off with the endpoint and bootstrap signature",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const store = yield* CredentialStore.ConnectionCredentialStore;
          const reject = (registration: PlatformConnectionRegistration) =>
            Effect.gen(function* () {
              if (registration._tag !== "BearerConnectionRegistration")
                throw new Error("Expected bearer");
              yield* store.put(registration.target.connectionId, registration.credential);
              yield* store.removeIfMatches!(
                registration.target.connectionId,
                registration.credential,
              );
            });
          const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          yield* reject(first[0]!);
          const fresh = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          expect(endpoint.tokenRequests).toHaveLength(2);
          yield* reject(fresh[0]!);
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual(fresh);
          yield* TestClock.adjust("3 seconds");
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual(fresh);
          expect(endpoint.tokenRequests).toHaveLength(2);
          yield* TestClock.adjust("57 seconds");
          const retried = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          expect(endpoint.tokenRequests).toHaveLength(3);
          yield* reject(retried[0]!);
          yield* Stream.runHead(source.registrations);
          yield* TestClock.adjust("60 seconds");
          yield* Stream.runHead(source.registrations);
          expect(endpoint.tokenRequests).toHaveLength(3);
          endpoint.rotate();
          yield* Stream.runHead(source.registrations);
          expect(endpoint.tokenRequests).toHaveLength(4);
        }).pipe(
          Effect.provide(
            layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect("delayed rejections after clean polls retain growing recovery backoff", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint(undefined, 3_600);
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const store = yield* CredentialStore.ConnectionCredentialStore;
        const poll = source.registrations.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        const reject = (registration: PlatformConnectionRegistration) =>
          Effect.gen(function* () {
            if (registration._tag !== "BearerConnectionRegistration")
              throw new Error("Expected bearer");
            yield* store.put(registration.target.connectionId, registration.credential);
            yield* store.removeIfMatches!(
              registration.target.connectionId,
              registration.credential,
            );
          });

        const nextPoll = Effect.gen(function* () {
          yield* TestClock.adjust("3 seconds");
          return yield* poll;
        });
        const first = yield* poll;
        yield* reject(first[0]!);
        const recovered = yield* nextPoll;
        expect(endpoint.tokenRequests).toHaveLength(2);
        expect(yield* nextPoll).toEqual(recovered);
        yield* reject(recovered[0]!);
        expect(yield* nextPoll).toEqual(recovered);
        for (let index = 0; index < 19; index++) {
          expect(yield* nextPoll).toEqual(recovered);
        }
        expect(endpoint.tokenRequests).toHaveLength(2);
        const retried = yield* nextPoll;
        expect(endpoint.tokenRequests).toHaveLength(3);
        for (let index = 0; index < 3; index++) {
          expect(yield* nextPoll).toEqual(retried);
        }
        yield* reject(retried[0]!);
        expect(yield* nextPoll).toEqual(retried);
        for (let index = 0; index < 39; index++) {
          expect(yield* nextPoll).toEqual(retried);
        }
        expect(endpoint.tokenRequests).toHaveLength(3);
        const replacement = yield* nextPoll;
        expect(endpoint.tokenRequests).toHaveLength(4);
        expect(replacement[0]).not.toEqual(retried[0]);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect(
    "recovers immediately from an independent revocation after a sustained healthy recovery",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint(undefined, 3_600);
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const store = yield* CredentialStore.ConnectionCredentialStore;
          const poll = source.registrations.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          const reject = (registration: PlatformConnectionRegistration) =>
            Effect.gen(function* () {
              if (registration._tag !== "BearerConnectionRegistration")
                throw new Error("Expected bearer");
              yield* store.put(registration.target.connectionId, registration.credential);
              yield* store.removeIfMatches!(
                registration.target.connectionId,
                registration.credential,
              );
            });

          const first = yield* poll;
          yield* reject(first[0]!);
          const recovered = yield* poll;
          // Build a real rejection history before proving a later healthy bearer resets it.
          yield* reject(recovered[0]!);
          yield* poll;
          expect(endpoint.tokenRequests).toHaveLength(2);
          yield* TestClock.adjust("60 seconds");
          const healthy = yield* poll;
          expect(endpoint.tokenRequests).toHaveLength(3);
          for (let index = 0; index < 100; index++) {
            yield* TestClock.adjust("3 seconds");
            expect(yield* poll).toEqual(healthy);
          }
          yield* reject(healthy[0]!);
          const replacement = yield* poll;
          expect(endpoint.tokenRequests).toHaveLength(4);
          expect(replacement[0]).not.toEqual(healthy[0]);
        }).pipe(
          Effect.provide(
            layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect(
    "the production platform layer shares credential rejection history with its source",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        let catalog: string | null = null;
        Object.assign(window.desktopBridge!, {
          getConnectionCatalog: async () => catalog,
          setConnectionCatalog: async (next: string) => {
            catalog = next;
            return true;
          },
        });
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const store = yield* CredentialStore.ConnectionCredentialStore;
          const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          const registration = first[0]!;
          if (registration._tag !== "BearerConnectionRegistration")
            throw new Error("Expected bearer");
          yield* store.put(registration.target.connectionId, registration.credential);
          yield* store.removeIfMatches!(registration.target.connectionId, registration.credential);
          const recovered = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          expect(endpoint.tokenRequests).toHaveLength(2);
          expect(recovered[0]).not.toEqual(registration);
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect("reuses a valid bearer when the endpoint and bootstrap token are unchanged", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        yield* TestClock.adjust("3 seconds");
        const next = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(first).toHaveLength(1);
        expect(next[0]).toBe(first[0]);
        expect(endpoint.tokenRequests).toHaveLength(1);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );
});
