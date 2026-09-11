import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type PullRequestStack,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "./pullRequests.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import { executeAtomQuery } from "./runtime.ts";

class MutationRefused extends Data.TaggedError("MutationRefused") {}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader,
        PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry };
});

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

it.effect("keeps workspace scope in writable PR queries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { atoms } = yield* makeTestRuntime({} as WsRpcProtocolClient);
      const input = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        workspace: { threadId: ThreadId.make("thread-1"), repositoryPath: "projects/web" },
      };
      for (const family of [atoms.detail, atoms.activity]) {
        const scoped = family({ environmentId: TARGET.environmentId, input });
        expect(scoped).not.toBe(
          family({
            environmentId: TARGET.environmentId,
            input: {
              projectId: input.projectId,
              repository: input.repository,
              number: input.number,
            },
          }),
        );
        expect(scoped).not.toBe(
          family({
            environmentId: TARGET.environmentId,
            input: {
              ...input,
              workspace: { ...input.workspace, threadId: ThreadId.make("thread-2") },
            },
          }),
        );
        expect(scoped).toBe(
          family({
            environmentId: TARGET.environmentId,
            input: {
              ...input,
              workspace: {
                repositoryPath: input.workspace.repositoryPath,
                threadId: input.workspace.threadId,
              },
            },
          }),
        );
      }
    }),
  ),
);

it.effect("refreshes pull request activity after a comment is updated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let commentBody = "old comment";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.succeed({
            author: null,
            reviewers: [],
            comments: [
              {
                id: "comment-1",
                kind: "issue-comment",
                author: null,
                body: commentBody,
                createdAt: "2026-08-24T00:00:00Z",
                url: null,
                path: null,
                reviewState: null,
                reactions: [],
              },
            ],
            commentCount: 1,
            commentsTruncated: false,
            reviewThreads: [],
            commits: [],
            reactions: [],
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input: { readonly body: string }) =>
          Effect.sync(() => {
            commentBody = input.body;
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const reference = {
        projectId: ProjectId.make("project-1"),
        host: "github.example.com",
        repository: "acme/web",
        number: 1,
      } as const;
      const activity = atoms.activity({ environmentId: TARGET.environmentId, input: reference });
      const unmount = registry.mount(activity);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      const initial = yield* Effect.promise(() => executeAtomQuery(registry, activity));
      expect(AsyncResult.isSuccess(initial)).toBe(true);
      if (!AsyncResult.isSuccess(initial)) {
        return yield* Effect.die("activity did not load");
      }
      expect(initial.value.comments[0]?.body).toBe("old comment");

      const update = yield* Effect.promise(() =>
        atoms.updateComment.run(registry, {
          environmentId: TARGET.environmentId,
          input: { ...reference, commentId: "comment-1", kind: "issue-comment", body: "updated" },
        }),
      );

      expect(AsyncResult.isSuccess(update)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("updated");
      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(activity, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.comments[0]?.body === "after turn") {
          refreshed.openUnsafe();
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));

      commentBody = "after turn";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;

      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("after turn");
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
              return yield* Effect.fail(new MutationRefused());
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
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).labels).toEqual([
        addedLabel,
      ]);
      yield* releaseDetailRefresh.open;
      yield* Effect.exit(AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true }));
      expect(AsyncResult.isFailure(registry.get(detail))).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).labels).toEqual([
        addedLabel,
      ]);
      failDetail = false;
      registry.refresh(detail);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).labels,
      ).toEqual([existing]);
      expect(detailReads).toBe(3);
    }),
  ),
);

it.effect("updates reviewer requests and enriched reviewers without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      let refuse = false;
      const actor = { login: "reviewer", name: "Reviewer", avatarUrl: null };
      const hostActor = { ...actor, login: "Reviewer" };
      let hostRequested = false;
      let reviewed = false;
      let pauseActivity = false;
      const activityStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.sync(() => {
            reads++;
            return { reviewers: hostRequested ? [hostActor] : [] };
          }),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.gen(function* () {
            reads++;
            if (pauseActivity) {
              pauseActivity = false;
              yield* activityStarted.open;
              return yield* Effect.never;
            }
            return {
              reviewers: hostRequested ? [hostActor] : [],
              comments: reviewed ? [{ kind: "review-comment", author: hostActor }] : [],
            };
          }),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input: { number: number }) =>
          input.number === 2
            ? Effect.never
            : Effect.sync(() => {
                reads++;
                return {
                  candidates: [{ ...actor, id: "12", kind: "user", isRequested: false }],
                  truncated: false,
                };
              }),
        [WS_METHODS.pullRequestsRequestReviewers]: (input: { requested: boolean }) =>
          refuse
            ? Effect.fail(new MutationRefused())
            : Effect.sync(() => {
                hostRequested = input.requested;
              }),
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
      const activity = atoms.activity(target);
      const candidates = atoms.reviewerCandidates(target);
      registry.mount(detail);
      registry.mount(activity);
      registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });
      const request = (requested: boolean, reference = target) =>
        Effect.promise(() =>
          atoms.requestReviewers.run(registry, {
            ...reference,
            input: { ...reference.input, reviewers: [{ id: "12", kind: "user" }], requested },
          }),
        );
      for (const operation of ["request", "refuse", "remove"]) {
        refuse = operation === "refuse";
        expect((yield* request(operation === "request"))._tag).toBe(refuse ? "Failure" : "Success");
        const expected = operation === "remove" ? [] : [actor];
        expect((yield* AtomRegistry.getResult(registry, detail)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { isRequested: operation !== "remove" },
        ]);
      }
      expect(reads).toBe(3);
      // A slow activity read started before the write must not hide the new request.
      pauseActivity = true;
      registry.refresh(activity);
      yield* activityStarted.await;
      expect(AsyncResult.isSuccess(yield* request(true))).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).reviewers,
      ).toEqual([hostActor]);
      expect(reads).toBe(5);
      expect(AsyncResult.isSuccess(yield* request(false))).toBe(true);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([]);

      reviewed = true;
      yield* request(true);
      registry.refresh(activity);
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* request(false);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([hostActor]);

      // A caller without an open picker still needs authoritative reviewer identities.
      const otherTarget = { ...target, input: { ...target.input, number: 2 } };
      const otherDetail = atoms.detail(otherTarget);
      registry.mount(otherDetail);
      yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true });
      yield* request(true, otherTarget);
      expect(
        (yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true }))
          .reviewers,
      ).toEqual([hostActor]);
    }),
  ),
);

it.effect("refreshes stack state after reopening and head SHAs after a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let state: "closed" | "open" = "closed";
      let headSha = "old-head";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsStack]: () =>
          Effect.sync(
            () =>
              ({
                id: "stack-1",
                number: 1,
                url: "https://github.com/acme/web/pull/1",
                base: "main",
                layers: [
                  {
                    number: 1,
                    headBranch: "feature",
                    headSha,
                    state,
                    isDraft: false,
                  },
                ],
              }) satisfies PullRequestStack,
          ),
      } as unknown as WsRpcProtocolClient;
      const { runtime, registry } = yield* makeTestRuntime(client);
      const stacks = createPullRequestStackAtomFamily(runtime);
      const stack = stacks({
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
        },
      });
      const unmount = registry.mount(stack);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => executeAtomQuery(registry, stack));
      expect((yield* AtomRegistry.getResult(registry, stack))?.layers[0]?.state).toBe("closed");
      state = "open";
      registry.refresh(stack);
      expect(
        (yield* AtomRegistry.getResult(registry, stack, { suspendOnWaiting: true }))?.layers[0]
          ?.state,
      ).toBe("open");

      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(stack, (result) => {
        if (AsyncResult.isSuccess(result) && result.value?.layers[0]?.headSha === "new-head") {
          refreshed.openUnsafe();
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      headSha = "new-head";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;
      expect((yield* AtomRegistry.getResult(registry, stack))?.layers[0]?.headSha).toBe("new-head");
    }),
  ),
);
