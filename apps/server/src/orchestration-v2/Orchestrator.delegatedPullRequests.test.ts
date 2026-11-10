import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type PullRequestDetail,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderKind,
  type ThreadProfileSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for delegated pull requests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "delegated-pull-requests" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const profile = (profileId: string): ThreadProfileSnapshot => ({
  profileId,
  profileName: profileId,
  revision: 1,
  effectiveSource: {
    modelSelection: "profile",
    runtimeMode: "profile",
    interactionMode: "profile",
    reasoningEffort: "profile",
  },
});

const projectId = ProjectId.make("project:delegated-pull-requests");
const captain = ThreadId.make("captain");
const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
const url = "https://github.com/pingdotgg/t3code/pull/7";
const at = "2026-10-02T12:00:00.000Z";
const detail: PullRequestDetail = {
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId,
  projectTitle: "Delegated pull requests",
  workspaceRoot: "/workspace/delegated",
  repository: key.repository,
  number: key.number,
  title: "Watched pull request",
  body: "",
  url,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: at,
  updatedAt: at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
};

it.effect(
  "delegated threads own no pull requests: only the watching thread wakes, and unwatching ends every watch",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:captain"),
        threadId: captain,
        projectId,
        title: "Captain",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        profileSnapshot: profile("captain"),
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch:captain"),
        threadId: captain,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:captain"),
        threadId: captain,
        messageId: MessageId.make("message:captain"),
        text: "Coordinate the feature",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* projections.getThreadRecords(captain, ["runs"])).runs.at(-1)!;
      const delegate = (suffix: string, profileId?: string) =>
        orchestrator
          .dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(`delegate:${suffix}`),
            parentThreadId: captain,
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            task: `Task ${suffix}`,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
            ...(profileId === undefined ? {} : { profileSnapshot: profile(profileId) }),
          })
          .pipe(
            Effect.map(
              (result) =>
                result.storedEvents.find((stored) => stored.event.type === "thread.created")!.event
                  .threadId,
            ),
          );
      // A named agent (a child chat) and a profile-less helper (a subagent).
      const worker = yield* delegate("worker", "doug");
      const helper = yield* delegate("helper");

      for (const threadId of [worker, helper]) {
        const thread = yield* projections.getThread(threadId);
        assert.deepEqual(thread.pullRequests ?? [], []);
        assert.isNull(thread.linkedPullRequest ?? null);
        assert.isNull(thread.branchPullRequest ?? null);
        // Lineage still returns each result to the delegator.
        assert.equal(thread.parentThreadId, captain);
        assert.equal(thread.lineage.parentThreadId, captain);
      }
      assert.deepEqual(
        (yield* projections.getThreadsWithPullRequests()).map((thread) => thread.id),
        [captain],
      );

      let hostReads = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () => Effect.sync(() => (hostReads += 1)).pipe(Effect.as(detail)),
              activity: () =>
                Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
            }),
          ),
        ),
      );
      yield* reactor.sweep;

      const wakes = (threadId: ThreadId) =>
        projections
          .getThreadRecords(threadId, ["messages"])
          .pipe(
            Effect.map(({ messages }) =>
              messages.flatMap((message) =>
                message.notification === undefined ? [] : [message.notification.summary],
              ),
            ),
          );
      assert.equal(hostReads, 1);
      assert.deepEqual(yield* wakes(captain), ["#7: checks failed"]);
      assert.deepEqual(yield* wakes(worker), []);
      assert.deepEqual(yield* wakes(helper), []);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("unwatch:captain"),
        threadId: captain,
        ...key,
        watching: false,
      });
      const watched = (yield* projections.getThreadsWithPullRequests()).filter((thread) =>
        (thread.pullRequests ?? []).some((link) => link.watch !== undefined),
      );
      assert.deepEqual(watched, []);
      yield* reactor.sweep;
      assert.equal(hostReads, 1);
    }).pipe(Effect.provide(testLayer)),
);
