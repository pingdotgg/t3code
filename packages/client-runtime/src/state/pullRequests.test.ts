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
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AsyncResult,
  Atom,
  AtomRegistry,
} from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createLinkedPullRequestSummaryAtomFamily } from "./pullRequests.ts";
import { executeAtomQuery } from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { PullRequestRoutingPermissions } from "../connection/pullRequestRoutingPermissions.ts";
import { MutationRefused, TARGET, session, trustedRouting } from "./pullRequests.part2.testkit.ts";
import { makeTestRuntime } from "./pullRequests.part3.testkit.ts";

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

it.effect("shares one refresh stream between independently created pull request readers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let subscriptions = 0;
      let title = "Original title";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
          Stream.unwrap(
            Effect.sync(() => {
              subscriptions++;
              return SubscriptionRef.changes(revision);
            }),
          ),
        [WS_METHODS.pullRequestsSummary]: () => Effect.sync(() => ({ title, state: "open" })),
        [WS_METHODS.pullRequestsDetail]: () => Effect.sync(() => ({ title, state: "open" })),
      } as unknown as WsRpcProtocolClient;
      const { runtime, atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const summary = createLinkedPullRequestSummaryAtomFamily(runtime)(target);
      const detail = atoms.detail(target);
      for (const atom of [summary, detail]) {
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        expect((yield* AtomRegistry.getResult(registry, atom)).title).toBe(title);
      }
      yield* AtomRegistry.getResult(
        registry,
        atoms.refreshes({ environmentId: target.environmentId, input: {} }),
      );
      expect(subscriptions).toBe(1);

      const changed = [summary, detail].map((atom) => {
        const ready = Latch.makeUnsafe();
        const stop = registry.subscribe(atom, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.title === "Updated title") {
            ready.openUnsafe();
          }
        });
        return { ready, stop };
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => changed.forEach(({ stop }) => stop())));
      title = "Updated title";
      yield* SubscriptionRef.update(revision, (value) => value + 1);
      for (const { ready } of changed) yield* ready.await;
      expect(subscriptions).toBe(1);
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
