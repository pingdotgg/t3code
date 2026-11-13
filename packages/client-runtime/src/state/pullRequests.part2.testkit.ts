// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import { RpcPermissionGuard } from "../rpc/client.ts";
import {
  EnvironmentId,
  ProjectId,
  PullRequestOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { PullRequestRoutingPermissions } from "../connection/pullRequestRoutingPermissions.ts";
import { makeTestRuntime } from "./pullRequests.part3.testkit.ts";

export const trustedRouting = {
  get: () => Effect.succeed("read-write" as const),
  changes: Stream.empty,
  set: () => Effect.void,
  forget: () => Effect.void,
};

export class MutationRefused extends Data.TaggedError("MutationRefused") {}

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

export const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

export function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: client[WS_METHODS.serverGetConfig]?.({}).pipe(Effect.orDie) ?? Effect.never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}
