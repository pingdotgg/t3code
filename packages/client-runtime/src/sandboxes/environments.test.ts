import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type AgentctlSandbox } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import {
  BearerConnectionCredential,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  SandboxEnvironments,
  layer as sandboxEnvironmentsLayer,
  reachedSandboxes,
  sandboxConnectionId,
  sandboxForTarget,
  sandboxRegistration,
  sandboxRoute,
  watchSandboxEnvironments,
} from "./environments.ts";

const HOST = EnvironmentId.make("host-env");
const SANDBOX = EnvironmentId.make("sandbox-env");

const sandbox: AgentctlSandbox & { readonly environmentId: EnvironmentId } = {
  name: "worker-1",
  phase: "ready",
  detail: null,
  since: null,
  cpu: null,
  memory: null,
  disk: null,
  network: null,
  sshAccess: true,
  environmentId: SANDBOX,
  settingsSeeded: false,
  harnesses: [],
  workingDirectory: "/home/agent/code",
  connectError: null,
  action: null,
  actionError: null,
  manifestPath: null,
  variant: null,
};

describe("Sandbox environments", () => {
  it("reaches a Sandbox below its host's address, however the client reaches the host", () => {
    expect(sandboxRoute("http://100.64.0.7:3773/", "worker-1")).toEqual({
      httpBaseUrl: "http://100.64.0.7:3773/sandbox/worker-1/",
      wsBaseUrl: "ws://100.64.0.7:3773/sandbox/worker-1/",
    });
    expect(sandboxRoute("https://machine.tailnet.ts.net/", "worker-1").wsBaseUrl).toBe(
      "wss://machine.tailnet.ts.net/sandbox/worker-1/",
    );
  });

  it("registers a Sandbox as a bearer environment that names its host", () => {
    const registration = sandboxRegistration({
      hostEnvironmentId: HOST,
      hostLabel: "desktop",
      hostHttpBaseUrl: "http://192.168.1.20:3773/",
      sandbox,
      token: "sandbox-token",
    });
    expect(registration.target.environmentId).toBe(SANDBOX);
    // Another host can have a Sandbox of the same name.
    expect(registration.target.label).toBe("worker-1 (desktop)");
    expect(registration.profile.httpBaseUrl).toBe("http://192.168.1.20:3773/sandbox/worker-1/");
    expect(registration.credential).toEqual(
      new BearerConnectionCredential({ token: "sandbox-token" }),
    );
    expect(sandboxForTarget(registration.target)).toEqual({
      hostEnvironmentId: HOST,
      name: "worker-1",
    });
  });

  it("does not take other environments for Sandboxes", () => {
    expect(
      sandboxForTarget(
        new BearerConnectionTarget({
          environmentId: SANDBOX,
          label: "laptop",
          connectionId: "bearer:sandbox-env:http://192.168.1.20:3773",
        }),
      ),
    ).toBeNull();
    expect(
      sandboxForTarget(
        new SshConnectionTarget({
          environmentId: SANDBOX,
          label: "worker-1",
          connectionId: sandboxConnectionId(HOST, "worker-1", SANDBOX),
        }),
      ),
    ).toBeNull();
  });

  it("makes every Sandbox it has reached an environment, running or not", () => {
    const reached = reachedSandboxes([
      sandbox,
      { ...sandbox, name: "stopped", phase: "stopped" },
      { ...sandbox, name: "new", environmentId: null },
    ]);
    expect(reached.map((candidate) => candidate.name)).toEqual(["worker-1", "stopped"]);
  });

  it("lets go of a Sandbox as soon as it is being deleted", () => {
    const reached = reachedSandboxes([
      { ...sandbox, name: "deleting", action: "deleting" },
      { ...sandbox, name: "terminating", phase: "terminating" },
      { ...sandbox, name: "stopping", action: "stopping" },
    ]);
    expect(reached.map((candidate) => candidate.name)).toEqual(["stopping"]);
  });

  it("gives a recreated Sandbox a connection of its own", () => {
    expect(sandboxConnectionId(HOST, "worker-1", SANDBOX)).not.toBe(
      sandboxConnectionId(HOST, "worker-1", EnvironmentId.make("recreated")),
    );
  });
});

const connectionState = (
  phase: "connected" | "blocked",
  attempt = 1,
): SupervisorConnectionState => ({
  desired: true,
  network: "online",
  phase,
  stage: null,
  attempt,
  generation: 1,
  lastFailure:
    phase === "blocked"
      ? new ConnectionBlockedError({ reason: "authentication", detail: "Session expired." })
      : null,
  retryAt: null,
  refusedRouteIds: [],
});

describe("Sandbox environment watcher", () => {
  it.effect("pairs again each time the Sandbox turns its session down", () =>
    Effect.gen(function* () {
      const connectionId = sandboxConnectionId(HOST, sandbox.name, SANDBOX);
      const stored = new Map<string, ConnectionCredential>([
        [connectionId, new BearerConnectionCredential({ token: "expired-token" })],
      ]);
      const state = yield* SubscriptionRef.make(connectionState("blocked"));
      let pairings = 0;
      let issued = 0;
      const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        // Only its keys are read.
        entries: yield* SubscriptionRef.make(
          new Map([[HOST, {} as ConnectionCatalogEntry]]) as ReadonlyMap<
            EnvironmentId,
            ConnectionCatalogEntry
          >,
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        followStream: <A>() =>
          Stream.concat(
            Stream.make({
              snapshot: {
                status: "available",
                error: null,
                sandboxes: [sandbox],
                homeDirectory: "/",
              },
              httpBaseUrl: "http://192.168.1.20:3773/",
            } as A),
            Stream.never,
          ),
        run: <A>() =>
          Effect.sync(() => {
            pairings += 1;
            return { environmentId: SANDBOX, pairingToken: `code-${pairings}` } as A;
          }),
        state: () => SubscriptionRef.get(state),
        stateChanges: () => SubscriptionRef.changes(state),
        retryNow: () => Effect.void,
      });
      const fetchToken: typeof globalThis.fetch = () => {
        issued += 1;
        return Promise.resolve(
          Response.json({
            access_token: `token-${issued}`,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "orchestration:read",
          }),
        );
      };
      const tokenRegistered = (token: string) =>
        Effect.flatMap(SandboxEnvironments, (environments) =>
          SubscriptionRef.changes(environments.registrations).pipe(
            Stream.filter((registrations) =>
              registrations.some(
                (registration) =>
                  registration.credential._tag === "BearerConnectionCredential" &&
                  registration.credential.token === token,
              ),
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );

      yield* Effect.gen(function* () {
        yield* Effect.forkChild(watchSandboxEnvironments());
        yield* tokenRegistered("token-1");
        // The new session works, until it too runs out.
        yield* SubscriptionRef.set(state, connectionState("connected", 2));
        yield* SubscriptionRef.set(state, connectionState("blocked", 3));
        yield* tokenRegistered("token-2");
        expect(pairings).toBe(2);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            sandboxEnvironmentsLayer,
            registry,
            Layer.succeed(
              ConnectionCredentialStore.ConnectionCredentialStore,
              ConnectionCredentialStore.make({
                get: (id) => Effect.succeed(Option.fromNullishOr(stored.get(id))),
                put: (id, credential) => Effect.sync(() => void stored.set(id, credential)),
                remove: (id) => Effect.sync(() => void stored.delete(id)),
              }),
            ),
            Layer.succeed(
              ClientCapabilities.ClientPresentation,
              ClientCapabilities.ClientPresentation.of({ metadata: {} }),
            ),
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchToken)),
            ),
          ),
        ),
      );
    }),
  );
  it.effect("leaves a stopped Sandbox's turned-down session until it starts", () =>
    Effect.gen(function* () {
      const connectionId = sandboxConnectionId(HOST, sandbox.name, SANDBOX);
      const stored = new Map<string, ConnectionCredential>([
        [connectionId, new BearerConnectionCredential({ token: "expired-token" })],
      ]);
      let watched = 0;
      const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries: yield* SubscriptionRef.make(
          new Map([[HOST, {} as ConnectionCatalogEntry]]) as ReadonlyMap<
            EnvironmentId,
            ConnectionCatalogEntry
          >,
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        followStream: <A>() =>
          Stream.concat(
            Stream.make({
              snapshot: {
                status: "available",
                error: null,
                sandboxes: [{ ...sandbox, phase: "stopped" }],
                homeDirectory: "/",
              },
              httpBaseUrl: "http://192.168.1.20:3773/",
            } as A),
            Stream.never,
          ),
        run: () => Effect.die("A stopped Sandbox cannot pair."),
        state: () => Effect.succeed(connectionState("blocked")),
        stateChanges: () => {
          watched += 1;
          return Stream.make(connectionState("blocked")).pipe(Stream.concat(Stream.never));
        },
        retryNow: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const environments = yield* SandboxEnvironments;
        yield* Effect.forkChild(watchSandboxEnvironments());
        yield* SubscriptionRef.changes(environments.registrations).pipe(
          Stream.filter((registrations) => registrations.length > 0),
          Stream.runHead,
        );
        yield* TestClock.adjust("1 minute");
        // Watching it would find the old rejection at once, and pair again and again.
        expect(watched).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            sandboxEnvironmentsLayer,
            registry,
            Layer.succeed(
              ConnectionCredentialStore.ConnectionCredentialStore,
              ConnectionCredentialStore.make({
                get: (id) => Effect.succeed(Option.fromNullishOr(stored.get(id))),
                put: (id, credential) => Effect.sync(() => void stored.set(id, credential)),
                remove: (id) => Effect.sync(() => void stored.delete(id)),
              }),
            ),
            Layer.succeed(
              ClientCapabilities.ClientPresentation,
              ClientCapabilities.ClientPresentation.of({ metadata: {} }),
            ),
            FetchHttpClient.layer,
          ),
        ),
      );
    }),
  );
});
