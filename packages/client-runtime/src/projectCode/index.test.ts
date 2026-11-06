import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProjectCodeIndexTarget,
  type ProjectCodeIndexEvent,
  WS_METHODS,
  type AuthSessionState,
  type ProjectCodeQueryInput,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectCodeAtoms, projectCodeIndexBadge } from "./index.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("code-environment"),
  label: "Code environment",
  httpBaseUrl: "https://code.example.test",
  wsBaseUrl: "wss://code.example.test",
});
const input: ProjectCodeQueryInput = {
  projectId: ProjectId.make("project"),
  query: { operation: "symbols", filePath: "src/index.ts" },
};
const session = (scopes: ReadonlyArray<typeof AuthFilesystemReadScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [...scopes],
  permissions: [...scopes],
});

const setup = Effect.fn("TestProjectCode.setup")(function* (indexEvents = true) {
  const subscriptions: ProjectCodeIndexTarget[] = [];
  const events = yield* PubSub.unbounded<{
    target: ProjectCodeIndexTarget;
    event: ProjectCodeIndexEvent;
  }>();
  const subscribed = yield* Deferred.make<void>();
  const requests: ProjectCodeQueryInput[] = [];
  const rpcSession = {
    initialConfig: Effect.succeed({
      environment: { capabilities: { projectCode: true, projectCodeIndexEvents: indexEvents } },
    } as unknown as ServerConfig),
    client: {
      [WS_METHODS.projectCodeSubscribeIndex]: (request: ProjectCodeIndexTarget) =>
        Stream.fromPubSub(events).pipe(
          Stream.filter((change) => change.target.threadId === request.threadId),
          Stream.map((change) => change.event),
          Stream.onStart(
            Effect.sync(() => subscriptions.push(request)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
        ),
      [WS_METHODS.projectCodeQuery]: (request: ProjectCodeQueryInput) =>
        Effect.sync(() => {
          requests.push(request);
          return { operation: "symbols" };
        }),
    },
  } as unknown as RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
    setDiscoveredRoutes: () => Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        followStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return {
    atoms: createProjectCodeAtoms(runtime),
    registry,
    requests,
    subscriptions,
    events,
    subscribed,
  };
});

describe("project code atoms", () => {
  it.effect.each(["published", "failed"] as const)(
    "%s refreshes only the mounted checkout freshness and queries",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { atoms, registry, requests, subscriptions, events, subscribed } = yield* setup();
          registry.set(
            sessions(target.environmentId),
            AsyncResult.success(session([AuthFilesystemReadScope])),
          );
          const checkout = { projectId: input.projectId, threadId: ThreadId.make("mounted") };
          const query = atoms.query({
            environmentId: target.environmentId,
            input: { ...input, ...checkout },
          });
          const freshness = atoms.freshness({
            environmentId: target.environmentId,
            input: { ...checkout, query: { operation: "freshness" } },
          });
          const otherCheckout = { ...checkout, threadId: ThreadId.make("other") };
          const otherQuery = atoms.query({
            environmentId: target.environmentId,
            input: { ...input, ...otherCheckout },
          });
          const refreshed = yield* Deferred.make<void>();
          const observe = () => {
            if (requests.filter((request) => request.threadId === checkout.threadId).length >= 4)
              Deferred.doneUnsafe(refreshed, Exit.void);
          };
          const stopQuery = registry.subscribe(query, observe);
          const stopFreshness = registry.subscribe(freshness, observe);
          const stopOther = registry.subscribe(otherQuery, () => {});
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopQuery();
              stopFreshness();
              stopOther();
            }),
          );
          yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
          yield* AtomRegistry.getResult(registry, freshness, { suspendOnWaiting: true });
          yield* AtomRegistry.getResult(registry, otherQuery, { suspendOnWaiting: true });
          expect(subscriptions).toContainEqual(checkout);
          yield* Deferred.await(subscribed);
          yield* PubSub.publish(events, {
            target: checkout,
            event: { outcome, generation: outcome === "published" ? 1 : null },
          });
          yield* Deferred.await(refreshed);
          expect(
            requests.filter((request) => request.threadId === otherCheckout.threadId),
          ).toHaveLength(1);
          expect(
            requests.filter(
              (request) =>
                request.threadId === checkout.threadId && request.query.operation === "symbols",
            ),
          ).toHaveLength(2);
          expect(
            requests.filter((request) => request.query.operation === "freshness"),
          ).toHaveLength(2);
        }),
      ),
  );
  it.effect("subscribes a mounted code target only when index events are advertised", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const enabled of [true, false]) {
          const { atoms, registry, subscriptions } = yield* setup(enabled);
          registry.set(
            sessions(target.environmentId),
            AsyncResult.success(session([AuthFilesystemReadScope])),
          );
          const query = atoms.query({ environmentId: target.environmentId, input });
          const stop = registry.subscribe(query, () => {});
          yield* Effect.addFinalizer(() => Effect.sync(stop));
          yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
          expect(subscriptions).toEqual(enabled ? [{ projectId: input.projectId }] : []);
        }
      }),
    ),
  );
  it.effect("queries with the filesystem read grant and refuses without it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, requests } = yield* setup();
        registry.set(sessions(target.environmentId), AsyncResult.success(session([])));
        expect(registry.get(atoms.query.permissionAtom(target.environmentId))).toBe(false);
        const denied = atoms.query({ environmentId: target.environmentId, input });
        const deniedResult = yield* AtomRegistry.getResult(registry, denied, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(deniedResult).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(requests).toEqual([]);

        registry.set(
          sessions(target.environmentId),
          AsyncResult.success(session([AuthFilesystemReadScope])),
        );
        expect(registry.get(atoms.query.permissionAtom(target.environmentId))).toBe(true);
        registry.refresh(denied);
        const allowed = yield* AtomRegistry.getResult(registry, denied, {
          suspendOnWaiting: true,
        });
        expect(allowed).toEqual({ operation: "symbols" });
        expect(requests).toEqual([input]);
      }),
    ),
  );

  it("names the indexed commit only when HEAD has moved past a stale index", () => {
    const index = {
      state: "stale" as const,
      indexedCommit: "abcdef0123456789",
      headCommit: "abcdef0123456789",
      generation: 3,
      indexedAt: 0,
      changedFiles: 2,
      changedPaths: ["a.ts", "b.ts"],
    };
    expect(projectCodeIndexBadge(index).label).toBe("Stale");
    expect(projectCodeIndexBadge({ ...index, headCommit: "1234567890abcdef" }).label).toBe(
      "Stale @abcdef0",
    );
    expect(projectCodeIndexBadge({ ...index, state: "unindexed" }).label).toBe("Not indexed");
    expect(projectCodeIndexBadge({ ...index, state: "unindexed", refresh: "building" }).label).toBe(
      "Indexing",
    );
    // No earlier generation exists to answer, so a failed first build must not claim one does.
    const firstIndexFailed = projectCodeIndexBadge({
      ...index,
      state: "unindexed",
      refresh: "failed",
    });
    expect(firstIndexFailed).toMatchObject({ label: "Index failed", tone: "warn" });
    expect(firstIndexFailed.detail).not.toContain("still answering");
    // A failed refresh leaves the older generation answering, and the badge says so.
    expect(projectCodeIndexBadge({ ...index, refresh: "failed" })).toMatchObject({
      label: "Stale",
      detail: expect.stringContaining("refresh failed"),
    });
    // A server from before index tracking cannot claim the index is ready.
    expect(projectCodeIndexBadge(undefined).label).toBe("Unavailable");
  });

  it.effect("re-reads a query only for a real publication or a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, requests, events, subscribed } = yield* setup();
        registry.set(
          sessions(target.environmentId),
          AsyncResult.success(session([AuthFilesystemReadScope])),
        );
        const checkout = { projectId: input.projectId, threadId: ThreadId.make("mounted") };
        const query = atoms.query({
          environmentId: target.environmentId,
          input: { ...input, ...checkout },
        });
        const freshness = atoms.freshness({
          environmentId: target.environmentId,
          input: { ...checkout, query: { operation: "freshness" } },
        });
        const queryRuns = () =>
          requests.filter(
            (request) =>
              request.threadId === checkout.threadId && request.query.operation === "symbols",
          ).length;
        const freshnessRuns = () =>
          requests.filter((request) => request.query.operation === "freshness").length;
        let onQuery = () => {};
        let onFreshness = () => {};
        const stopQuery = registry.subscribe(query, () => onQuery());
        const stopFreshness = registry.subscribe(freshness, () => onFreshness());
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            stopQuery();
            stopFreshness();
          }),
        );
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, freshness, { suspendOnWaiting: true });
        yield* Deferred.await(subscribed);
        expect([queryRuns(), freshnessRuns()]).toEqual([1, 1]);

        // One event at a time: a stream atom keeps only the last value of a chunk.
        const publish = Effect.fn("TestProjectCode.publish")(function* (
          event: ProjectCodeIndexEvent,
          expected: readonly [query: number, freshness: number],
        ) {
          const reached = yield* Deferred.make<void>();
          onQuery = onFreshness = () => {
            if (queryRuns() >= expected[0] && freshnessRuns() >= expected[1]) {
              Deferred.doneUnsafe(reached, Exit.void);
            }
          };
          yield* PubSub.publish(events, { target: checkout, event });
          yield* Deferred.await(reached);
          expect([queryRuns(), freshnessRuns()]).toEqual(expected);
        });
        // Freshness re-reads on every event. The query only re-runs for a real publication,
        // because a query starts the build a settle removal just stopped.
        const reRead: ProjectCodeIndexEvent = { outcome: "published", generation: null };
        yield* publish(reRead, [1, 2]);
        yield* publish({ outcome: "published", generation: 1 }, [2, 3]);
        // A settle removes the index, the next turn announces its rebuild with the same signal,
        // and generation numbers restart once the files are gone.
        yield* publish(reRead, [2, 4]);
        yield* publish(reRead, [2, 5]);
        yield* publish({ outcome: "published", generation: 1 }, [3, 6]);
      }),
    ),
  );
});
