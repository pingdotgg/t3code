import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ROLLBACK_FAILED_MESSAGE } from "./CheckpointRollbackService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "./pullRequestWatch.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  modelSelection,
  watchedPullRequestDetail,
  seedProject,
  layerTest,
} from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("a watch that ends on the comment limit keeps what its last pass saw", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-limit");
      const projectId = ProjectId.make("pr-watch-limit-project");
      yield* seedProject({
        projectId,
        title: "Watch limit",
        workspaceRoot: "/workspace/watch-limit",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-limit-create"),
        threadId,
        projectId,
        title: "Watch limit",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 13 };
      const watch = (id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-limit-${id}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/13", source: "agent" },
        });
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0],
      );
      yield* watch("start");
      const started = (yield* watchOf)?.watch;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-limit-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: {
          ...started,
          headSha: "abc1234def",
          passed: true,
          passedChecks: ["lint"],
          wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
        },
      });

      let status: "pending" | "success" = "pending";
      const commentAt = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(started.startedAt), { seconds: 1 }),
      );
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({ projectId, number: 13, at: commentAt }),
              checks: [{ name: "lint", status, description: null, url: null, required: true }],
            })),
          activity: () =>
            Effect.succeed({
              comments: [
                {
                  id: "reviewer-comment",
                  kind: "issue-comment" as const,
                  author: { login: "reviewer", name: null, avatarUrl: null },
                  body: "One more thing.",
                  createdAt: commentAt,
                  url: "https://github.com/pingdotgg/t3code/pull/13#comment",
                  path: null,
                  reviewState: null,
                },
              ],
              commentCount: 1,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      const ended = yield* watchOf;
      assert.isUndefined(ended?.watch);
      assert.isFalse(ended?.endedWatch?.passed);
      assert.deepEqual(yield* summaries, ["#13: new comments, stopped watching"]);

      status = "success";
      yield* TestClock.adjust("10 minutes");
      yield* watch("again");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, [
        "#13: new comments, stopped watching",
        "#13: checks passed",
      ]);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-limit-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  // regression: #23701 a head no check runs on never woke the watch
  it.effect("wakes once when no checks report on the head, without saying they passed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-no-checks");
      const projectId = ProjectId.make("pr-watch-no-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch no checks",
        workspaceRoot: "/workspace/watch-no-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-no-checks-create"),
        threadId,
        projectId,
        title: "Watch no checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
      });

      // A docs-only push that path filters keep every workflow off.
      let headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      const anHourOfSweeps = Effect.gen(function* () {
        for (let pass = 0; pass < 6; pass++) {
          yield* reactor.sweep;
          yield* TestClock.adjust("10 minutes");
        }
        yield* reactor.sweep;
      });

      yield* anHourOfSweeps;
      const told = yield* wakes;
      assert.equal(told.length, 1, "one wake for a head with no checks");
      assert.notMatch(told[0]!.text, /\bpass/i);
      assert.notEqual(told[0]!.notification?.outcome, "completed");

      // An empty read on a head whose checks were seen is a failed read, not "no checks".
      headSha = "7777777777";
      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      // Without a fingerprint, a quiet pull request is read again only once the reread is due.
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      checks = [];
      yield* anHourOfSweeps;
      assert.equal((yield* wakes).length, 1);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );
  it.effect("wakes for checks that complete after the no-checks notice on the same head", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-late-checks");
      const projectId = ProjectId.make("pr-watch-late-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch late checks",
        workspaceRoot: "/workspace/watch-late-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-late-checks-create"),
        threadId,
        projectId,
        title: "Watch late checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
      });

      const headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
      yield* sweep;
      assert.lengthOf(yield* wakes, 0);
      yield* TestClock.adjust("20 minutes");
      yield* sweep;
      const noChecks = yield* wakes;
      assert.lengthOf(noChecks, 1);
      assert.include(noChecks[0]!.text, "No checks have reported");
      assert.equal(noChecks[0]!.notification?.outcome, "updated");

      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      assert.lengthOf(yield* wakes, 1);

      checks = [{ name: "lint", status: "success", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      const completed = yield* wakes;
      assert.lengthOf(completed, 2);
      assert.equal(completed[1]!.notification?.summary, "#14: checks passed");
      assert.include(completed[1]!.text, "All 1 required check passed on 6074dd4.");
      assert.equal(completed[1]!.notification?.outcome, "completed");

      yield* TestClock.adjust("1 hour");
      yield* sweep;
      const settled = yield* wakes;
      assert.lengthOf(settled, 2);
      assert.lengthOf(
        settled.filter((message) => message.text.includes("No checks have reported")),
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
      yield* worker.drain();
    }),
  );
  it.effect.each([true, false])(
    "reads a quiet head when its no-checks notice comes due (fingerprint: %s)",
    (fingerprinted) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-due-${fingerprinted}`);
        const projectId = ProjectId.make(`pr-watch-due-project-${fingerprinted}`);
        yield* seedProject({
          projectId,
          title: "Watch no-checks deadline",
          workspaceRoot: "/workspace/watch-due",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-due-create-${fingerprinted}`),
          threadId,
          projectId,
          title: "Watch no-checks deadline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-start-${fingerprinted}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
        });

        let reads = 0;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            // The host reports the same fingerprint throughout, so only the deadline can prompt a read.
            watchFingerprint: () =>
              Effect.succeed(fingerprinted ? { status: "quiet", remarks: "none" } : null),
            invalidate: () => Effect.void,
            detail: () =>
              Effect.sync(() => {
                reads++;
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 14,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "6074dd48ff",
                  checks: [],
                };
              }),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter((message) => message.text.includes("No checks have reported")),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));

        yield* sweep;
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.lengthOf(yield* wakes, 0);

        yield* TestClock.adjust("6 minutes");
        yield* sweep;
        const told = yield* wakes;
        assert.lengthOf(told, 1);
        assert.include(told[0]!.text, "after 16 minutes");

        // The notice clears the deadline, so the watch returns to its quiet cadence.
        const readsAfterNotice = reads;
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, readsAfterNotice);
        assert.lengthOf(yield* wakes, 1);

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-end-${fingerprinted}`),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("watching a dismissed stack layer again keeps what its last watch told", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-dismissed");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-dismissed-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-dismissed-project"),
        title: "Watch dismissed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      const url = "https://github.com/pingdotgg/t3code/pull/14";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("pr-watch-dismissed-link"),
        threadId,
        ...key,
        url,
        source: "stack",
      });
      const watching = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-dismissed-${id}`),
          threadId,
          ...key,
          watching: on,
          link: { url, source: "agent" },
        });
      yield* watching(true, "start");
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-dismissed-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...started, headSha: "abc1234def", passed: true, passedChecks: ["lint"] },
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("pr-watch-dismissed-unlink"),
        threadId,
        ...key,
      });
      yield* watching(true, "again");
      const again = yield* watchOf;
      assert.equal(again?.headSha, "abc1234def");
      assert.isTrue(again?.passed);
      yield* watching(false, "end");
    }),
  );
});
