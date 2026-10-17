import type {
  ModelSelection,
  OrchestrationV2ThreadShell,
  ProjectId,
  RuntimeMode,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeAssert from "node:assert";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlReadContext from "@t3tools/source-control-core/server/SourceControlReadContext";

/** Checks reactor-owned reads against the real GitHub admission gate with held HTTP answers. */
export const makeGitHubReadAdmissionFixture = Effect.gen(function* () {
  const entries = new Map<
    string,
    { readonly started: Deferred.Deferred<void>; readonly response: Deferred.Deferred<void> }
  >();
  const requests: string[] = [];
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          source: "env" as const,
          token: Redacted.make("admission-fixture"),
          fingerprint: `${host}:admission-fixture`,
        }),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        const entry = entries.get(path)!;
        requests.push(path);
        yield* Deferred.succeed(entry.started, undefined);
        yield* Deferred.await(entry.response);
        return HttpClientResponse.fromWeb(request, new Response('{"ok":true}'));
      }),
    ),
  );
  const context = yield* Layer.build(
    GitHubRest.layer.pipe(
      Layer.provide(Layer.mergeAll(credentials, http)),
      Layer.provideMerge(GitHubQuota.layer),
      Layer.provideMerge(SourceControlRateLimit.layer),
    ),
  );
  const api = yield* GitHubRest.GitHubRest.pipe(Effect.provideContext(context));
  const prepare = Effect.fnUntraced(function* (path: string, hold = false) {
    const started = yield* Deferred.make<void>();
    const response = yield* Deferred.make<void>();
    entries.set(`/${path}`, { started, response });
    if (!hold) yield* Deferred.succeed(response, undefined);
    return {
      started,
      release: Deferred.succeed(response, undefined),
      read: api
        .rest({ host: "github.com", operation: "admission-fixture", path })
        .pipe(Effect.orDie),
    };
  });
  let sequence = 0;
  const proveBackgroundRead = <A, E, R>(name: string, answer: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const prefix = `${sequence++}-${name}`;
      const blockers = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        (index) => prepare(`${prefix}-block-${index}`, true),
      );
      const blockingFibers = yield* Effect.forEach(blockers, (entry) =>
        entry.read.pipe(
          Effect.provideService(SourceControlReadContext.Background, true),
          Effect.forkChild({ startImmediately: true }),
        ),
      );
      yield* Effect.forEach(blockers, (entry) => Deferred.await(entry.started));
      const first = yield* prepare(`${prefix}-tail-first`);
      const second = yield* prepare(`${prefix}-tail-second`);
      const firstFiber = yield* first.read.pipe(
        Effect.provideService(SourceControlReadContext.Background, true),
        Effect.forkChild({ startImmediately: true }),
      );
      const secondFiber = yield* second.read.pipe(
        Effect.provideService(SourceControlReadContext.Background, true),
        Effect.forkChild({ startImmediately: true }),
      );
      const target = yield* prepare(`${prefix}-target`);
      const ordinary = yield* prepare(`${prefix}-ordinary`);
      const targetFiber = yield* target.read.pipe(Effect.forkChild({ startImmediately: true }));
      const ordinaryFiber = yield* ordinary.read.pipe(
        Effect.provideService(SourceControlReadContext.Background, false),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* blockers[0]!.release;
      yield* Fiber.join(targetFiber);
      yield* Fiber.join(ordinaryFiber);
      yield* Fiber.join(firstFiber);
      yield* Fiber.join(secondFiber);
      const targetIndex = requests.indexOf(`/${prefix}-target`);
      NodeAssert.strict.ok(requests.indexOf(`/${prefix}-ordinary`) < targetIndex);
      NodeAssert.strict.ok(requests.indexOf(`/${prefix}-tail-second`) < targetIndex);
      yield* Effect.forEach(blockers.slice(1), (entry) => entry.release);
      yield* Effect.forEach(blockingFibers, Fiber.join);
      NodeAssert.strict.equal(requests.filter((path) => path.startsWith(`/${prefix}-`)).length, 12);
      return yield* answer;
    });
  return { proveBackgroundRead };
});

export interface PullRequestTestThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null;
  readonly latestUserMessageAt: string | null;
  readonly lineage?: OrchestrationV2ThreadShell["lineage"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: OrchestrationV2ThreadShell["settledOverride"];
  readonly settledAt: string | null;
}

export function v2PullRequestThread(thread: PullRequestTestThread): OrchestrationV2ThreadShell {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.modelSelection.instanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: thread.pullRequests,
    linkedPullRequest: thread.linkedPullRequest,
    branchPullRequest: thread.branchPullRequest,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: thread.lineage ?? {
      rootThreadId: thread.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: thread.latestUserMessageAt
      ? DateTime.makeUnsafe(thread.latestUserMessageAt)
      : null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe(thread.createdAt),
    updatedAt: DateTime.makeUnsafe(thread.updatedAt),
    archivedAt: thread.archivedAt ? DateTime.makeUnsafe(thread.archivedAt) : null,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt ? DateTime.makeUnsafe(thread.settledAt) : null,
    deletedAt: null,
  };
}
