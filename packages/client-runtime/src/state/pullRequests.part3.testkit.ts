// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import { RpcPermissionGuard } from "../rpc/client.ts";
import {
  EnvironmentId,
  ProjectId,
  PullRequestOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
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
import { createPullRequestEnvironmentAtoms } from "./pullRequests.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { PullRequestRoutingPermissions } from "../connection/pullRequestRoutingPermissions.ts";
import { TARGET, session, trustedRouting } from "./pullRequests.part2.testkit.ts";

export const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (
  client: WsRpcProtocolClient,
  localClient?: WsRpcProtocolClient,
  localOrigin = false,
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
  const atoms = createPullRequestEnvironmentAtoms(runtime);
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
