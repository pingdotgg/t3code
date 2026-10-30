import { createCommandPermissions } from "./commandPermissions.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  AuthSourceControlWriteScope,
  AuthOrchestrationOperateScope,
  ProjectId,
  PullRequestOperationError,
  WS_METHODS,
  type AuthSessionState,
  type PullRequestListInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { SshConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
} from "./pullRequests.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { executeAtomQuery } from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { PullRequestRoutingPermissions } from "../connection/pullRequestRoutingPermissions.ts";

const trustedRouting = {
  get: () => Effect.succeed("read-write" as const),
  changes: Stream.empty,
  set: () => Effect.void,
  forget: () => Effect.void,
};

class MutationRefused extends Data.TaggedError("MutationRefused") {}

for (const scenario of [
  "prefers the local environment with the same github account",
  "falls back before mutation when the local account differs",
  "never retries an ambiguous mutation failure",
  "returns a fast local source read without checking alternate identities",
  "keeps single-environment requests free of identity lookups",
  "keeps a local origin ahead of another local environment",
  "keeps mutations on an old origin server without retrying them",
  "skips an old alternate server before dispatching a mutation",
  "returns a successful mutation when source invalidation stalls",
  "does not dispatch after routing permission is revoked during the probe",
  "keeps mutations on the origin when the alternate is disabled",
  "does not dispatch after the alternate is disabled during the probe",
  "preserves a local source account rejection when alternate accounts differ",
] as const) {
  (scenario === "returns a successful mutation when source invalidation stalls"
    ? it.live
    : it.effect)(scenario, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const inputs: unknown[] = [];
        let trusted = true;
        let disableAlternate = Effect.void;
        const switchedAccount =
          scenario === "preserves a local source account rejection when alternate accounts differ";
        const mismatch =
          scenario === "falls back before mutation when the local account differs" ||
          switchedAccount;
        const ambiguous = scenario === "never retries an ambiguous mutation failure";
        const reading =
          scenario === "returns a fast local source read without checking alternate identities";
        const single = scenario === "keeps single-environment requests free of identity lookups";
        const localOrigin =
          scenario === "keeps a local origin ahead of another local environment" ||
          switchedAccount ||
          reading;
        const oldOrigin =
          scenario === "keeps mutations on an old origin server without retrying them";
        const oldAlternate =
          scenario === "skips an old alternate server before dispatching a mutation";
        const failure = new PullRequestOperationError({
          operation: switchedAccount ? "routeIdentity" : "runAction",
          detail: "connection lost after dispatch",
        });
        const clientFor = (local: boolean) => {
          const name = local ? "local" : "origin";
          return {
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: (
              input: unknown,
            ) =>
              Effect.gen(function* () {
                if (local) expect(input).toEqual({ host: "github.com" });
                calls.push(`${name}:identity`);
                if (
                  local &&
                  scenario === "does not dispatch after the alternate is disabled during the probe"
                )
                  yield* disableAlternate;
                if (
                  local &&
                  scenario ===
                    "does not dispatch after routing permission is revoked during the probe"
                )
                  trusted = false;
                if ((!local && oldOrigin) || (local && oldAlternate)) {
                  return yield* Effect.die(
                    `Unknown request tag: ${WS_METHODS.pullRequestsRouting}`,
                  );
                }
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria-rcks",
                  accountId: local && mismatch ? "456" : "123",
                };
              }),
            [WS_METHODS.pullRequestsRunAction]: (input: unknown) =>
              Effect.gen(function* () {
                calls.push(`${name}:mutation`);
                inputs.push(input);
                if (
                  !local &&
                  switchedAccount &&
                  (input as { expectedAccountId?: string }).expectedAccountId === "123"
                )
                  return yield* failure;
                if (local && ambiguous) return yield* failure;
              }),
            [WS_METHODS.pullRequestsSummary]: (input: { allowStale?: boolean }) =>
              Effect.gen(function* () {
                calls.push(`${name}:read`);
                expect(input.allowStale).toBe(false);
                if (local) return yield* failure;
                return null;
              }),
            [WS_METHODS.pullRequestsInvalidate]: () =>
              Effect.gen(function* () {
                calls.push(`${name}:invalidate`);
                if (
                  !local &&
                  scenario === "returns a successful mutation when source invalidation stalls"
                ) {
                  return yield* Effect.never;
                }
              }),
          } as unknown as WsRpcProtocolClient;
        };
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          single ? undefined : clientFor(true),
          localOrigin,
        );
        disableAlternate = SubscriptionRef.update(
          environmentRegistry.entries,
          (entries) =>
            new Map(
              [...entries].map(([id, entry]) => [
                id,
                id === TARGET.environmentId ? entry : { ...entry, enabled: false },
              ]),
            ),
        );
        const disabled =
          scenario === "keeps mutations on the origin when the alternate is disabled";
        const disabledDuringProbe =
          scenario === "does not dispatch after the alternate is disabled during the probe";
        if (disabled) yield* disableAlternate;
        const input = {
          projectId: ProjectId.make("project-1"),
          host: "github.com",
          repository: "acme/web",
          number: 7,
          action: "merge" as const,
        };
        const route = createPullRequestRouter();
        const result = yield* (
          reading
            ? route(WS_METHODS.pullRequestsSummary, input)
            : route(WS_METHODS.pullRequestsRunAction, input)
        ).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          Effect.provideService(PullRequestRoutingPermissions, {
            ...trustedRouting,
            get: () => Effect.succeed(trusted ? "read-write" : "off"),
          }),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.result,
        );

        if (switchedAccount) {
          expect(result).toMatchObject({ _tag: "Failure", failure });
          expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["origin:mutation"]);
          expect(inputs).toEqual([{ ...input, expectedAccountId: "123" }]);
        } else if (ambiguous) {
          expect(result).toMatchObject({ _tag: "Failure", failure });
          expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["local:mutation"]);
        } else {
          expect(result._tag).toBe("Success");
          if (single || disabled) {
            expect(calls.filter((call) => !call.endsWith(":invalidate"))).toEqual([
              "origin:mutation",
            ]);
          } else if (reading) expect(calls).toEqual(["origin:read"]);
          else if (
            mismatch ||
            localOrigin ||
            oldOrigin ||
            oldAlternate ||
            !trusted ||
            disabledDuringProbe
          )
            expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["origin:mutation"]);
          else {
            expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["local:mutation"]);
            expect(calls).toContain("origin:invalidate");
            expect(inputs).toEqual([{ ...input, expectedAccountId: "123" }]);
          }
        }
      }),
    ),
  );
}

it.effect.each([
  { probe: "origin", cancelled: "first" },
  { probe: "origin", cancelled: "waiter" },
  { probe: "alternate", cancelled: "first" },
  { probe: "alternate", cancelled: "waiter" },
] as const)(
  "preserves a shared $probe probe's other reader when the $cancelled cancels",
  ({ probe, cancelled }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let probes = 0;
        const clientFor = (local: boolean) =>
          ({
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
              Effect.gen(function* () {
                if (local === (probe === "alternate")) {
                  probes++;
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria",
                  accountId: "123",
                };
              }),
            [WS_METHODS.pullRequestsSummary]: () => Effect.succeed(null),
          }) as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          clientFor(true),
        );
        const read = () =>
          createPullRequestRouter()(WS_METHODS.pullRequestsSummary, {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number: 7,
          }).pipe(
            Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
          );
        const first = yield* read().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const waiter = yield* read().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(cancelled === "first" ? first : waiter);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(cancelled === "first" ? waiter : first)).toBeNull();
        expect(probes).toBe(cancelled === "first" ? 2 : 1);
        yield* read();
        expect(probes).toBe(cancelled === "first" ? 3 : 2);
      }),
    ),
);

it.effect.each(["revoked", "disabled"] as const)(
  "rechecks routing after an alternate with a shared probe is %s",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reads: string[] = [];
        let trusted = true;
        let probes = 0;
        const clientFor = (local: boolean) =>
          ({
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
              Effect.gen(function* () {
                if (local) {
                  probes++;
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria",
                  accountId: "123",
                };
              }),
            [WS_METHODS.pullRequestsSummary]: () =>
              Effect.sync(() => {
                reads.push(local ? "local" : "origin");
                return null;
              }),
          }) as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          clientFor(true),
        );
        const readers = yield* Effect.all(
          Array.from({ length: 2 }, () =>
            createPullRequestRouter()(WS_METHODS.pullRequestsSummary, {
              projectId: ProjectId.make("project-1"),
              repository: "acme/web",
              number: 7,
            }),
          ),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(PullRequestRoutingPermissions, {
            ...trustedRouting,
            get: () => Effect.sync(() => (trusted ? "read-write" : "off")),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        if (change === "revoked") trusted = false;
        else
          yield* SubscriptionRef.update(
            environmentRegistry.entries,
            (entries) =>
              new Map(
                [...entries].map(([id, entry]) => [
                  id,
                  id === TARGET.environmentId ? entry : { ...entry, enabled: false },
                ]),
              ),
          );
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(readers)).toEqual([null, null]);
        expect(probes).toBe(1);
        expect(reads).toEqual(["origin", "origin"]);
      }),
    ),
);

it.effect.each(["origin", "alternate"] as const)(
  "keeps pending metadata from an old %s connection separate from its replacement",
  (reconnected) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const probes: string[] = [];
        const clientFor = (local: boolean, replacement = false) =>
          ({
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
              Effect.gen(function* () {
                if (local === (reconnected === "alternate")) {
                  probes.push(replacement ? "new" : "old");
                  if (!replacement) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                }
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria",
                  accountId: "123",
                };
              }),
            [WS_METHODS.pullRequestsSummary]: () => Effect.succeed(null),
          }) as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor, localSupervisor } = yield* makeTestRuntime(
          clientFor(false),
          clientFor(true),
        );
        const read = () =>
          createPullRequestRouter()(WS_METHODS.pullRequestsSummary, {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number: 7,
          }).pipe(
            Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
          );
        const first = yield* read().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* SubscriptionRef.set(
          (reconnected === "origin" ? supervisor : localSupervisor).session,
          Option.some(session(clientFor(reconnected === "alternate", true))),
        );
        expect(yield* read()).toBeNull();
        expect(probes).toEqual(["old", "new"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBeNull();
      }),
    ),
);

it.effect("forgets routed viewed marks when a viewed-files batch fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reference = {
        projectId: ProjectId.make("project-1"),
        host: "github.com",
        repository: "acme/web",
        number: 7,
      };
      const invalidations: { environment: string; input: unknown }[] = [];
      const identity = () =>
        Effect.succeed({
          host: reference.host,
          provider: "github",
          accountId: "123",
          viewer: "maria-rcks",
        });
      const clientFor = (environment: string) =>
        ({
          [WS_METHODS.pullRequestsRouting]: identity,
          [WS_METHODS.pullRequestsRoutingIdentity]: identity,
          [WS_METHODS.pullRequestsFilesViewed]: () =>
            Effect.succeed({ files: [{ path: "a.ts", state: "unviewed" }], truncated: false }),
          // The host may have applied part of the batch before refusing the rest.
          [WS_METHODS.pullRequestsSetFilesViewed]: () => Effect.fail("second path refused"),
          [WS_METHODS.pullRequestsInvalidate]: (input: unknown) =>
            Effect.sync(() => {
              invalidations.push({ environment, input });
            }),
        }) as unknown as WsRpcProtocolClient;
      const { environmentRegistry, supervisor } = yield* makeTestRuntime(
        clientFor("origin"),
        clientFor("local"),
      );
      const route = createPullRequestRouter();
      const write = yield* Effect.gen(function* () {
        yield* route(WS_METHODS.pullRequestsFilesViewed, reference);
        return yield* Effect.exit(
          route(WS_METHODS.pullRequestsSetFilesViewed, {
            ...reference,
            files: [
              { path: "a.ts", viewed: true },
              { path: "b.ts", viewed: true },
            ],
          }),
        );
      }).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(write._tag).toBe("Failure");
      expect(invalidations).toContainEqual({
        environment: "local",
        input: { reference: expect.objectContaining(reference), filesViewedOnly: true },
      });
      for (const call of invalidations) {
        expect(call.input).toMatchObject({ filesViewedOnly: true });
      }
    }),
  ),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: client[WS_METHODS.serverGetConfig]?.({}).pipe(Effect.orDie) ?? Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (
  client: WsRpcProtocolClient,
  localClient?: WsRpcProtocolClient,
  localOrigin = false,
  onAnswer: Parameters<typeof createPullRequestEnvironmentAtoms>[1] = {},
) {
  const originTarget = localOrigin
    ? new PrimaryConnectionTarget({
        ...TARGET,
        httpBaseUrl: "http://localhost:3774",
        wsBaseUrl: "ws://localhost:3774",
      })
    : TARGET;
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: originTarget,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const localTarget = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("local-environment"),
    label: "Local environment",
    httpBaseUrl: "http://localhost:3773",
    wsBaseUrl: "ws://localhost:3773",
  });
  const localSupervisor = {
    ...supervisor,
    target: localTarget,
    session: yield* SubscriptionRef.make(Option.some(session(localClient ?? client))),
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          originTarget.environmentId,
          { target: originTarget, profile: Option.none(), enabled: true },
        ],
        ...(localClient === undefined
          ? []
          : [
              [
                localTarget.environmentId,
                { target: localTarget, profile: Option.none(), enabled: true },
              ] as const,
            ]),
      ]),
    ),
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        environmentId === localTarget.environmentId ? localSupervisor : supervisor,
      ),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader.PullRequestDiffLoader,
        PullRequestDiffLoader.PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime, onAnswer);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry, environmentRegistry, supervisor, localSupervisor };
});

it.effect.each([
  "default",
  "origin-off",
  "destination-off",
  "read-only",
  "destination-disabled",
  "destination-unsupported",
] as const)(
  "preserves source requests when routing to another environment is blocked by %s",
  (permission) =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const failure = new PullRequestOperationError({
          operation: "summary",
          detail: "source failed",
        });
        const client = {
          [WS_METHODS.pullRequestsSummary]: (input: { allowStale?: boolean }) =>
            Effect.suspend(() => {
              calls.push("source-read");
              expect(input.allowStale).toBeUndefined();
              return Effect.fail(failure);
            }),
          [WS_METHODS.pullRequestsRunAction]: () =>
            Effect.sync(() => {
              calls.push("source-write");
            }),
        } as unknown as WsRpcProtocolClient;
        const alternate = {
          [WS_METHODS.pullRequestsRoutingIdentity]: () =>
            Effect.die("untrusted environment was contacted"),
        } as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor, localSupervisor } = yield* makeTestRuntime(
          client,
          alternate,
        );
        if (permission === "destination-disabled" || permission === "destination-unsupported") {
          yield* SubscriptionRef.update(
            environmentRegistry.entries,
            (entries) =>
              new Map(
                [...entries].map(([id, entry]) => [
                  id,
                  id === TARGET.environmentId
                    ? entry
                    : {
                        ...entry,
                        enabled: permission !== "destination-disabled",
                        ...(permission === "destination-unsupported"
                          ? { unsupportedReason: "Protocol version mismatch" }
                          : {}),
                      },
                ]),
              ),
          );
          yield* SubscriptionRef.set(localSupervisor.session, Option.none());
        }
        const ref = {
          projectId: ProjectId.make("project-1"),
          repository: "private/repo",
          number: 7,
        };
        const request = Effect.gen(function* () {
          const route = createPullRequestRouter();
          if (permission !== "read-only")
            yield* route(WS_METHODS.pullRequestsSummary, ref).pipe(Effect.flip);
          yield* route(WS_METHODS.pullRequestsRunAction, { ...ref, action: "merge" });
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        );
        yield* permission === "default"
          ? request
          : request.pipe(
              Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
              Effect.provideService(PullRequestRoutingPermissions, {
                ...trustedRouting,
                get: (entry) =>
                  Effect.succeed(
                    permission === "read-only"
                      ? "read"
                      : permission === "destination-disabled" ||
                          permission === "destination-unsupported"
                        ? "read-write"
                        : (entry.target.environmentId === TARGET.environmentId) ===
                            (permission === "origin-off")
                          ? "off"
                          : "read-write",
                  ),
              }),
            );
        expect(calls).toEqual(
          permission === "read-only" ? ["source-write"] : ["source-read", "source-write"],
        );
      }),
    ),
);

it.effect.each(
  (["origin", "destination"] as const).flatMap((side) =>
    (["matching", "changed", "missing", "unavailable", "failed"] as const).map((stored) => ({
      side,
      stored,
    })),
  ),
)("checks the current $side SSH profile before routing with $stored storage", ({ side, stored }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      const identity = {
        host: "github.com",
        provider: "github",
        viewer: "maria",
        accountId: "123",
      };
      const client = {
        [WS_METHODS.pullRequestsRouting]: () =>
          Effect.sync(() => {
            calls.push("source-probe");
            return identity;
          }),
        [WS_METHODS.pullRequestsRunAction]: (input: { expectedAccountId?: string }) =>
          Effect.gen(function* () {
            if (input.expectedAccountId !== undefined) {
              return yield* new PullRequestOperationError({
                operation: "routeIdentity",
                detail: "Source guard refused.",
              });
            }
            calls.push("source-write");
          }),
        [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
      } as unknown as WsRpcProtocolClient;
      const alternate = {
        [WS_METHODS.pullRequestsRoutingIdentity]: () =>
          Effect.sync(() => {
            calls.push("alternate-probe");
            return identity;
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.sync(() => {
            calls.push("alternate-write");
          }),
        [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { environmentRegistry, supervisor } = yield* makeTestRuntime(client, alternate);
      const environmentId =
        side === "origin" ? TARGET.environmentId : EnvironmentId.make("local-environment");
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId,
        label: "SSH",
        target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
      });
      yield* SubscriptionRef.update(environmentRegistry.entries, (entries) =>
        new Map(entries).set(environmentId, {
          target: new SshConnectionTarget({
            environmentId,
            connectionId: profile.connectionId,
            label: "SSH",
          }),
          profile: Option.some(profile),
          enabled: true,
        }),
      );
      const read = Effect.suspend(() =>
        stored === "failed"
          ? Effect.fail(
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail: "Profile storage unavailable.",
              }),
            )
          : Effect.succeed(
              stored === "missing"
                ? Option.none()
                : Option.some(
                    stored === "changed"
                      ? new SshConnectionProfile({
                          ...profile,
                          target: { ...profile.target, hostname: "replacement.example.test" },
                        })
                      : profile,
                  ),
            ),
      );
      const route = createPullRequestRouter()(WS_METHODS.pullRequestsRunAction, {
        projectId: ProjectId.make("project-1"),
        repository: "private/repo",
        number: 7,
        action: "merge",
      }).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
      );
      yield* stored === "unavailable"
        ? route
        : route.pipe(
            Effect.provideService(ConnectionProfileStore.ConnectionProfileStore, {
              get: () => read,
              put: () => Effect.die("unused"),
              remove: () => Effect.die("unused"),
            }),
          );
      expect(calls).toEqual(
        stored === "matching"
          ? ["source-probe", "alternate-probe", "alternate-write"]
          : ["source-write"],
      );
    }),
  ),
);

it.live.each([undefined, true, false])(
  "keeps source workspace metadata and reports draft %s when an alternate answers a detail read",
  (isDraft) =>
    Effect.scoped(
      Effect.gen(function* () {
        const noted = yield* Deferred.make<unknown>();
        const clientFor = (local: boolean) =>
          ({
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
              Effect.succeed({
                host: "github.com",
                provider: "github",
                viewer: "maria-rcks",
                accountId: "123",
                projectTitle: local ? "local project" : "source project",
                workspaceRoot: local ? "/Users/local/repo" : "/srv/source/repo",
              }),
            [WS_METHODS.pullRequestsDetail]: () =>
              local
                ? Effect.succeed({
                    projectId: "local-project",
                    projectTitle: "local project",
                    workspaceRoot: "/Users/local/repo",
                    title: "github title",
                    state: "closed",
                    ...(isDraft === undefined ? {} : { isDraft }),
                    updatedAt: "2026-10-10T01:52:36Z",
                  })
                : Effect.never,
            [WS_METHODS.pullRequestsReportState]: (input: unknown) =>
              Deferred.succeed(noted, input).pipe(Effect.asVoid),
          }) as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          clientFor(true),
        );
        const result = yield* createPullRequestRouter()(WS_METHODS.pullRequestsDetail, {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 7,
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(result).toEqual({
          projectId: "project-1",
          projectTitle: "source project",
          workspaceRoot: "/srv/source/repo",
          title: "github title",
          state: "closed",
          ...(isDraft === undefined ? {} : { isDraft }),
          updatedAt: "2026-10-10T01:52:36Z",
        });
        expect(yield* Deferred.await(noted)).toEqual({
          reference: { projectId: "project-1", repository: "acme/web", number: 7 },
          state: "closed",
          ...(isDraft === undefined ? {} : { isDraft }),
        });
      }),
    ),
);

it.live(
  "refreshes identity before writes and invalidates prior readers across router instances",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let originAccountId = "123";
        const mutations: { environment: string; expectedAccountId: string }[] = [];
        const invalidations: { environment: string; input: unknown }[] = [];
        const identities: string[] = [];
        const clientFor = (local: boolean) => {
          const environment = local ? "local" : "origin";
          return {
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
              Effect.sync(() => {
                identities.push(environment);
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria-rcks",
                  accountId: local ? "123" : originAccountId,
                };
              }),
            [WS_METHODS.pullRequestsSummary]: () => (local ? Effect.succeed(null) : Effect.never),
            [WS_METHODS.pullRequestsRunAction]: (input: { expectedAccountId: string }) =>
              Effect.sync(() => {
                mutations.push({ environment, expectedAccountId: input.expectedAccountId });
              }),
            [WS_METHODS.pullRequestsInvalidate]: (input: unknown) =>
              Effect.sync(() => {
                invalidations.push({ environment, input });
              }),
          } as unknown as WsRpcProtocolClient;
        };
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          clientFor(true),
        );
        const reference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 7,
        };
        const hostedReference = { ...reference, host: "github.com", allowStale: false };
        const route = createPullRequestRouter();
        yield* Effect.gen(function* () {
          yield* route(WS_METHODS.pullRequestsSummary, reference);
          originAccountId = "456";
          yield* route(WS_METHODS.pullRequestsRunAction, { ...reference, action: "merge" });

          expect(identities.filter((environment) => environment === "origin")).toHaveLength(2);
          expect(mutations).toEqual([{ environment: "origin", expectedAccountId: "456" }]);
          expect(invalidations).toEqual(
            expect.arrayContaining([
              { environment: "origin", input: { reference: expect.objectContaining(reference) } },
              { environment: "origin", input: { reference: hostedReference } },
              { environment: "local", input: { reference: hostedReference } },
              { environment: "origin", input: {} },
              { environment: "local", input: {} },
            ]),
          );

          invalidations.length = 0;
          const refresh = createPullRequestRouter();
          yield* refresh(WS_METHODS.pullRequestsInvalidate, { reference });
          expect(invalidations).toContainEqual({
            environment: "local",
            input: { reference: hostedReference },
          });

          invalidations.length = 0;
          yield* refresh(WS_METHODS.pullRequestsInvalidate, {});
          expect(invalidations).toContainEqual({ environment: "local", input: {} });
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
      }),
    ),
);

it.effect("keeps concurrent diff file reads on different hosts separate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Latch.make();
      const started = yield* Latch.make();
      const calls: string[] = [];
      const client = {
        [WS_METHODS.pullRequestsDiffFileContents]: (input: { readonly host: string }) =>
          Effect.gen(function* () {
            calls.push(input.host);
            yield* started.open;
            yield* release.await;
            return { oldContents: "", newContents: input.host };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const input = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        changeType: "change",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
      } as const;
      const first = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.com" },
      });
      yield* started.await;
      const second = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.example.com" },
      });
      yield* release.open;

      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results).toMatchObject([
        { _tag: "Success", value: { newContents: "github.com" } },
        { _tag: "Success", value: { newContents: "github.example.com" } },
      ]);
      expect(calls).toEqual(["github.com", "github.example.com"]);
    }),
  ),
);

it.effect.each(["closed", "draft", "permission", "stack", "method"] as const)(
  "rejects an unsafe quick merge with %s and keeps later actions running",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.succeed({
              state: reason === "closed" ? "closed" : "open",
              isDraft: reason === "draft",
              capabilities: { actions: ["merge"], stackActions: true },
              viewerPermissions: { actions: reason === "permission" ? [] : ["merge"] },
            }),
          [WS_METHODS.pullRequestsStack]: () => Effect.succeed(reason === "stack" ? {} : null),
          [WS_METHODS.pullRequestsRunAction]: (input: { action: string }) =>
            Effect.sync(() => calls.push(input.action)),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = {
          environmentId: TARGET.environmentId,
          input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
        };
        const merge = atoms.runAction.run(registry, {
          ...target,
          input: {
            ...target.input,
            action: "merge",
            resolveMergeMethod: () => {
              if (reason === "method") throw new Error("No merge method is available.");
              return "squash";
            },
          },
        });
        const close = atoms.runAction.run(registry, {
          ...target,
          input: { ...target.input, action: "close" },
        });
        const results = yield* Effect.promise(() => Promise.all([merge, close]));
        expect(results.map((result) => result._tag)).toEqual(["Failure", "Success"]);
        expect(calls).toEqual(["close"]);
      }),
    ),
);

it.effect("keeps a close batch ordered and continues after a refused close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: number[] = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.pullRequestsRunAction]: (input: { number: number; action: string }) =>
          Effect.gen(function* () {
            expect(input.action).toBe("close");
            calls.push(input.number);
            if (input.number === 6) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            if (input.number === 5)
              return yield* new PullRequestOperationError({
                operation: "runAction",
                detail: "You cannot close this pull request.",
              });
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const batch = [6, 5, 4].map((number) =>
        atoms.runAction.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number,
            action: "close",
          },
        }),
      );
      yield* Deferred.await(started);
      expect(calls).toEqual([6]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all(batch));
      expect(results.map((result) => result._tag)).toEqual(["Success", "Failure", "Success"]);
      expect(calls).toEqual([6, 5, 4]);
    }),
  ),
);

const actionReference = {
  projectId: ProjectId.make("project-1"),
  host: "github.example.com",
  repository: "acme/web",
  number: 1,
};
const actionReply = {
  ...actionReference,
  provider: "github",
  title: "Ship it",
  url: "https://github.example.com/acme/web/pull/1",
  headBranch: "feature",
  baseBranch: "main",
  state: "merged" as const,
  isDraft: false,
  updatedAt: "2026-10-27T10:00:00Z",
  observedAt: 200,
};

function actionReplyClient(overrides: Record<string, unknown> = {}) {
  return {
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
    [WS_METHODS.pullRequestsRunAction]: () => Effect.succeed(actionReply),
    ...overrides,
  } as unknown as WsRpcProtocolClient;
}

it.effect("shows an action's reply in loaded readers and moves list rows without reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads: string[] = [];
      const open = { ...actionReference, state: "open", isDraft: true, observedAt: 100 };
      const read = (name: string) => () =>
        Effect.sync(() => {
          reads.push(name);
          return open;
        });
      const replies: unknown[] = [];
      const listAnswers: unknown[] = [];
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsDetail]: read("detail"),
        [WS_METHODS.pullRequestsPreview]: read("preview"),
        [WS_METHODS.pullRequestsSummary]: read("summary"),
        [WS_METHODS.pullRequestsList]: (input: { readonly state: string }) =>
          Effect.sync(() => {
            reads.push(`list:${input.state}`);
            return {
              entries: input.state === "merged" ? [] : [open],
              viewers: {},
              providers: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            };
          }),
      });
      const { atoms, registry, runtime } = yield* makeTestRuntime(client, undefined, false, {
        actionReply: (target, reply) => Effect.sync(() => replies.push({ target, reply })),
        list: (_target, value) => Effect.sync(() => listAnswers.push(value.entries)),
      });
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const list = (input: PullRequestListInput) =>
        atoms.list({ environmentId: target.environmentId, input });
      const readers: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<object, unknown>>> = [
        atoms.detail(target),
        atoms.preview(target),
        createLinkedPullRequestSummaryAtomFamily(runtime, atoms.refreshes)(target),
      ];
      // A reader without a host can resolve to another host, so only its own read updates it.
      const { host: _host, ...hostless } = actionReference;
      const otherHost = atoms.detail({ ...target, input: hostless });
      const all = list({ state: "all" });
      const openDrafts = list({ state: "open", filters: { draft: "only" } });
      const merged = list({ state: "merged" });
      for (const atom of [...readers, otherHost, all, openDrafts, merged]) {
        registry.mount(atom);
        yield* Effect.promise(() => executeAtomQuery(registry, atom));
      }
      reads.length = 0;

      const answer = yield* Effect.promise(() =>
        atoms.runAction.run(registry, { ...target, input: { ...target.input, action: "merge" } }),
      );

      expect(answer).toMatchObject({ _tag: "Success", value: actionReply });
      for (const atom of readers) {
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom)))).toMatchObject({
          state: "merged",
          isDraft: false,
          title: "Ship it",
        });
      }
      expect(Option.getOrThrow(AsyncResult.value(registry.get(all))).entries).toMatchObject([
        { state: "merged", isDraft: false, observedAt: 200 },
      ]);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(otherHost))).state).toBe("open");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(openDrafts))).entries).toEqual([]);
      expect(replies).toEqual([{ target, reply: actionReply }]);
      // Snapshot writers see the patched rows the way they see an answer.
      expect(listAnswers).toContainEqual([expect.objectContaining({ state: "merged" })]);
      // Only a read can place a row the listing did not hold.
      yield* AtomRegistry.getResult(registry, merged, { suspendOnWaiting: true });
      expect(reads).toEqual(["list:merged"]);
    }),
  ),
);

it.effect.each([false, true])(
  "keeps an action's reply when a pre-action read answers late (cached: %s)",
  (cached) =>
    Effect.scoped(
      Effect.gen(function* () {
        let state: "open" | "merged" = "open";
        let reads = 0;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const client = actionReplyClient({
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.gen(function* () {
              reads++;
              const snapshot = { ...actionReference, state, isDraft: false, observedAt: 100 };
              if (reads === (cached ? 2 : 1)) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release).pipe(
                  Effect.onExit(() => Deferred.succeed(settled, undefined)),
                );
              }
              return snapshot;
            }),
          [WS_METHODS.pullRequestsRunAction]: () =>
            Effect.sync(() => {
              state = "merged";
              return actionReply;
            }),
        });
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = { environmentId: TARGET.environmentId, input: actionReference };
        const detail = atoms.detail(target);
        registry.mount(detail);
        if (cached) {
          yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
          registry.refresh(detail);
        }
        yield* Deferred.await(started);

        yield* Effect.promise(() =>
          atoms.runAction.run(registry, {
            ...target,
            input: { ...actionReference, action: "merge" },
          }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(settled);

        expect(
          (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).state,
        ).toBe("merged");
        expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("merged");
      }),
    ),
);

it.effect("shows a reopen reply at once and re-reads the fields it lacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const release = yield* Deferred.make<void>();
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 1) return { ...actionReference, state: "closed", observedAt: 100 };
            yield* Deferred.await(release);
            return { ...actionReference, state: "open", observedAt: 300 };
          }),
        [WS_METHODS.pullRequestsRunAction]: () => Effect.succeed({ ...actionReply, state: "open" }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const detail = atoms.detail(target);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "reopen" },
        }),
      );

      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("open");
      expect(reads).toBe(2);
      yield* Deferred.succeed(release, undefined);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).observedAt,
      ).toBe(300);
    }),
  ),
);

it.effect.each([
  ["a newer update", "open", "2026-10-27T10:00:01Z", 100, "open"],
  ["the same update read later", "open", actionReply.updatedAt, 300, "open"],
  ["a merge", "merged", "2026-10-27T09:00:00Z", 100, "open"],
] as const)(
  "keeps %s when an older or reverting action reply arrives",
  ([, shownState, updatedAt, observedAt, replyState]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const shown = {
          ...actionReference,
          state: shownState,
          isDraft: true,
          updatedAt,
          observedAt,
        };
        const client = actionReplyClient({
          [WS_METHODS.pullRequestsDetail]: () => Effect.succeed(shown),
          [WS_METHODS.pullRequestsPreview]: () => Effect.succeed(shown),
          [WS_METHODS.pullRequestsRunAction]: () =>
            Effect.succeed({ ...actionReply, state: replyState }),
        });
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = { environmentId: TARGET.environmentId, input: actionReference };
        const readers = [atoms.detail(target), atoms.preview(target), atoms.previewCard(target)];
        for (const reader of readers) {
          registry.mount(reader);
          yield* AtomRegistry.getResult(registry, reader, { suspendOnWaiting: true });
        }

        yield* Effect.promise(() =>
          atoms.runAction.run(registry, {
            ...target,
            input: { ...actionReference, action: "ready" },
          }),
        );
        for (const reader of readers) {
          expect(Option.getOrThrow(AsyncResult.value(registry.get(reader)))).toMatchObject({
            state: shownState,
            isDraft: true,
          });
        }
      }),
    ),
);

it.effect("keeps hover previews fresh after edits and turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let title = "Original title";
      let reads = 0;
      const read = (input: unknown) =>
        Effect.sync(() => {
          expect(input).toEqual(reference);
          reads++;
          return { ...reference, title };
        });
      const reference = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        host: "github.example.com",
      };
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsPreview]: read,
        [WS_METHODS.pullRequestsDetail]: read,
        [WS_METHODS.pullRequestsUpdate]: (input: { title: string }) =>
          Effect.sync(() => {
            title = input.title;
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.sync(() => {
            title = "Closed";
          }),
        [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: reference };
      const preview = atoms.preview(target);
      const unmount = registry.mount(preview);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe(title);
      yield* Effect.promise(() => executeAtomQuery(registry, preview));
      expect(reads).toBe(1);
      const edited = yield* Effect.promise(() =>
        atoms.update.run(registry, { ...target, input: { ...reference, title: "Edited" } }),
      );
      expect(AsyncResult.isSuccess(edited)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Edited");
      yield* Effect.promise(() =>
        atoms.runAction.run(registry, { ...target, input: { ...reference, action: "close" } }),
      );
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Closed");
      title = "Refreshed";
      yield* Effect.promise(() =>
        atoms.invalidate.run(registry, {
          environmentId: target.environmentId,
          input: { reference },
        }),
      );
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Refreshed");
      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(preview, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.title === "After turn")
          refreshed.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      title = "After turn";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;
    }),
  ),
);

it.effect("shares close, reopen, and merge with an untouched client's mounted PR readers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let state: "open" | "closed" | "merged" = "open";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => SubscriptionRef.changes(revision),
        [WS_METHODS.pullRequestsSummary]: () => Effect.sync(() => ({ state })),
        [WS_METHODS.pullRequestsDetail]: () => Effect.sync(() => ({ state })),
        [WS_METHODS.pullRequestsList]: () =>
          Effect.sync(() => ({ entries: [{ number: 1, state }] })),
        [WS_METHODS.pullRequestsRunAction]: (input: {
          readonly action: "close" | "reopen" | "merge";
        }) =>
          Effect.gen(function* () {
            state =
              input.action === "close" ? "closed" : input.action === "merge" ? "merged" : "open";
            yield* SubscriptionRef.update(revision, (value) => value + 1);
          }),
      } as unknown as WsRpcProtocolClient;
      const writer = yield* makeTestRuntime(client);
      const reader = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          host: "github.example.com",
          repository: "acme/web",
          number: 1,
        },
      };
      const detail = reader.atoms.detail(target);
      const summary = createLinkedPullRequestSummaryAtomFamily(
        reader.runtime,
        reader.atoms.refreshes,
      )(target);
      const list = reader.atoms.list({
        environmentId: TARGET.environmentId,
        input: { state: "all" },
      });
      const unmountDetail = reader.registry.mount(detail);
      const unmountSummary = reader.registry.mount(summary);
      const unmountList = reader.registry.mount(list);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmountDetail();
          unmountSummary();
          unmountList();
        }),
      );
      expect((yield* AtomRegistry.getResult(reader.registry, detail)).state).toBe("open");
      expect((yield* AtomRegistry.getResult(reader.registry, summary)).state).toBe("open");
      expect((yield* AtomRegistry.getResult(reader.registry, list)).entries[0]?.state).toBe("open");

      for (const [action, expected] of [
        ["close", "closed"],
        ["reopen", "open"],
        ["merge", "merged"],
      ] as const) {
        const detailChanged = Latch.makeUnsafe();
        const summaryChanged = Latch.makeUnsafe();
        const listChanged = Latch.makeUnsafe();
        const stops = [
          reader.registry.subscribe(detail, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.state === expected) {
              detailChanged.openUnsafe();
            }
          }),
          reader.registry.subscribe(summary, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.state === expected) {
              summaryChanged.openUnsafe();
            }
          }),
          reader.registry.subscribe(list, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.entries[0]?.state === expected) {
              listChanged.openUnsafe();
            }
          }),
        ];
        yield* Effect.addFinalizer(() => Effect.sync(() => stops.forEach((stop) => stop())));
        const result = yield* Effect.promise(() =>
          writer.atoms.runAction.run(writer.registry, {
            ...target,
            input: { ...target.input, action },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        yield* detailChanged.await;
        yield* summaryChanged.await;
        yield* listChanged.await;
        expect((yield* AtomRegistry.getResult(reader.registry, detail)).state).toBe(expected);
        expect((yield* AtomRegistry.getResult(reader.registry, summary)).state).toBe(expected);
        expect((yield* AtomRegistry.getResult(reader.registry, list)).entries[0]?.state).toBe(
          expected,
        );
        stops.forEach((stop) => stop());
      }
    }),
  ),
);

it.effect("shares checks reads across reference property order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsChecks]: () =>
          Effect.sync(() => {
            reads += 1;
            return { state: "open", checks: [], observedAt: 1_000 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const projectId = ProjectId.make("project-1");
      const row = atoms.checks({
        environmentId: TARGET.environmentId,
        input: { host: "github.com", repository: "acme/web", number: 1, projectId },
      });
      const panel = atoms.checks({
        environmentId: TARGET.environmentId,
        input: { projectId, host: "github.com", repository: "acme/web", number: 1 },
      });
      yield* AtomRegistry.getResult(registry, row);
      yield* AtomRegistry.getResult(registry, panel);
      expect(reads).toBe(1);
    }),
  ),
);

it.effect("keeps live detail reads separate from reads that allow stale data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: (input: { allowStale?: boolean }) =>
          Effect.succeed({ title: input.allowStale === false ? "latest checks" : "cached checks" }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const cached = atoms.detail(target);
      const live = atoms.detail({ ...target, input: { ...target.input, allowStale: false } });
      expect((yield* AtomRegistry.getResult(registry, cached)).title).toBe("cached checks");
      expect((yield* AtomRegistry.getResult(registry, live)).title).toBe("latest checks");
    }),
  ),
);

it.effect("updates cached labels after successful edits without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let detailReads = 0;
      let candidateReads = 0;
      let refuse = false;
      let failDetail = false;
      const existing = { name: "existing", color: "111111" };
      const addedLabel = { name: "new", color: "abcdef" };
      const detailRefreshStarted = yield* Latch.make();
      const releaseDetailRefresh = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            detailReads++;
            if (failDetail) {
              yield* detailRefreshStarted.open;
              yield* releaseDetailRefresh.await;
              return yield* new MutationRefused();
            }
            return { title: "keep this title", labels: [existing] };
          }),
        [WS_METHODS.pullRequestsLabelCandidates]: () =>
          Effect.sync(() => {
            candidateReads++;
            return {
              candidates: [
                { ...existing, description: null, isApplied: true },
                { ...addedLabel, description: "description", isApplied: false },
              ],
              truncated: false,
            };
          }),
        [WS_METHODS.pullRequestsSetLabels]: () =>
          refuse ? Effect.fail(new MutationRefused()) : Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "github.example.com",
        },
      };
      const detail = atoms.detail(target);
      const candidates = atoms.labelCandidates(target);
      registry.mount(detail);
      const unmountCandidates = registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });

      const added = yield* Effect.promise(() =>
        atoms.setLabels.run(registry, {
          ...target,
          input: {
            host: target.input.host,
            projectId: target.input.projectId,
            repository: target.input.repository,
            number: target.input.number,
            labels: ["new"],
            applied: true,
          },
        }),
      );
      expect(AsyncResult.isSuccess(added)).toBe(true);
      expect(yield* AtomRegistry.getResult(registry, detail)).toEqual({
        title: "keep this title",
        labels: [existing, addedLabel],
      });
      unmountCandidates();
      registry.mount(atoms.labelCandidates(target));
      expect((yield* AtomRegistry.getResult(registry, candidates)).candidates[1]).toEqual({
        ...addedLabel,
        description: "description",
        isApplied: true,
      });

      for (const name of ["existing", "new"]) {
        refuse = name === "new";
        const result = yield* Effect.promise(() =>
          atoms.setLabels.run(registry, {
            ...target,
            input: { ...target.input, labels: [name], applied: false },
          }),
        );
        expect(result._tag).toBe(refuse ? "Failure" : "Success");
        expect((yield* AtomRegistry.getResult(registry, detail)).labels).toEqual([addedLabel]);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { name: "existing", isApplied: false },
          { name: "new", isApplied: true },
        ]);
      }
      expect(detailReads).toBe(1);
      expect(candidateReads).toBe(1);

      failDetail = true;
      registry.refresh(detail);
      yield* detailRefreshStarted.await;
      expect(registry.get(detail).waiting).toBe(true);
      expect(AsyncResult.getOrThrow(registry.get(detail)).labels).toEqual([addedLabel]);
      yield* releaseDetailRefresh.open;
      yield* Effect.exit(AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true }));
      expect(AsyncResult.isFailure(registry.get(detail))).toBe(true);
      expect(AsyncResult.getOrThrow(registry.get(detail)).labels).toEqual([addedLabel]);
      failDetail = false;
      registry.refresh(detail);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).labels,
      ).toEqual([existing]);
      expect(detailReads).toBe(3);
    }),
  ),
);

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
    }),
  ),
);

it.effect("denies a routed write when only the origin has source-control permission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let writes = 0;
      const identity = { host: "github.com", provider: "github", viewer: "test", accountId: "123" };
      const client = {
        [WS_METHODS.pullRequestsRouting]: () => Effect.succeed(identity),
        [WS_METHODS.pullRequestsRoutingIdentity]: () => Effect.succeed(identity),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.sync(() => {
            writes++;
          }),
      } as unknown as WsRpcProtocolClient;
      const fixture = yield* makeTestRuntime(client, client);
      const local = EnvironmentId.make("local-environment");
      const stop = fixture.registry.mount(grantedSessions(local));
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      fixture.registry.set(
        grantedSessions(local),
        AsyncResult.success({
          authenticated: true,
          scopes: [],
          auth: {
            policy: "remote-reachable" as const,
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
        }),
      );
      const error = yield* createPullRequestRouter()(WS_METHODS.pullRequestsRunAction, {
        projectId: ProjectId.make("project"),
        repository: "acme/repo",
        number: 1,
        action: "merge",
      }).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, fixture.environmentRegistry),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, fixture.supervisor),
        Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
        Effect.provideService(RpcPermissionGuard, {
          authorize: (id, method, input) =>
            createCommandPermissions(fixture.runtime, method).authorize(
              fixture.registry,
              id,
              input,
            ),
        }),
        Effect.flip,
      );
      expect(error._tag).toBe("EnvironmentAuthorizationError");
      expect(writes).toBe(0);
    }),
  ),
);

it.effect("publishes the accepted guide run before the follow-up read finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accepted = {
        guide: null,
        currentHeadSha: "head",
        run: { _tag: "Running" as const, headSha: "head", startedAt: "2026-10-11T00:00:00.000Z" },
      };
      let reads = 0;
      const refreshStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsReviewGuide]: () =>
          Effect.gen(function* () {
            if (++reads > 1) {
              yield* refreshStarted.open;
              return yield* Effect.never;
            }
            return { guide: null, run: null, currentHeadSha: "head" };
          }),
        [WS_METHODS.pullRequestsGenerateReviewGuide]: () => Effect.succeed(accepted),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      registry.update(
        grantedSessions(target.environmentId),
        AsyncResult.map((session) => ({
          ...session,
          scopes: [...(session.scopes ?? []), AuthOrchestrationOperateScope],
        })),
      );
      const query = atoms.reviewGuide(target);
      registry.mount(query);
      yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      const result = yield* Effect.promise(() => atoms.generateReviewGuide.run(registry, target));
      expect(result._tag).toBe("Success");
      yield* refreshStarted.await;
      expect(AsyncResult.getOrElse(registry.get(query), () => null)).toEqual(accepted);
    }),
  ),
);
