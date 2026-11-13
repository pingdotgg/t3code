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
  it.effect.each(["manual", "automatic"])("settling ends every pull request watch: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make(`pr-watch-settle-${mode}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-settle-create-${mode}`),
        threadId,
        projectId: ProjectId.make("pr-watch-settle-project"),
        title: "Settle watched PRs",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      for (const number of [7, 8]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-settle-start-${mode}-${number}`),
          threadId,
          ...key,
          number,
          watching: true,
          link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      const started = before?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      if (started === undefined || before === null) return;
      yield* orchestrator.dispatch({
        ...(mode === "manual"
          ? { type: "thread.settle" as const }
          : { type: "thread.auto-settle" as const, snapshotAt: before.updatedAt }),
        commandId: CommandId.make(`pr-watch-settle-${mode}`),
        threadId,
      });
      const expected = before.pullRequests?.map(({ watch, ...link }) => ({
        ...link,
        endedWatch: watch,
      }));
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);

      for (const wake of [
        undefined,
        {
          messageId: MessageId.make(`pr-watch-settle-late-wake-${mode}`),
          text: "Update",
          notification: {
            source: { kind: "monitor" as const },
            outcome: "updated" as const,
            summary: "#7",
          },
        },
      ]) {
        const late = yield* orchestrator
          .dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-settle-late-${mode}-${wake !== undefined}`),
            threadId,
            ...key,
            number: 7,
            startedAt: started.startedAt,
            watch: { ...started, headSha: "late", wakes: 1 },
            ...(wake === undefined ? {} : { wake }),
          })
          .pipe(Effect.flip);
        assert.equal(late._tag, "OrchestratorDispatchError");
      }
      const restart = {
        type: "thread.pull-request.watch" as const,
        threadId,
        ...key,
        number: 7,
        watching: true,
      };
      const blocked = yield* orchestrator
        .dispatch({
          ...restart,
          commandId: CommandId.make(`pr-watch-settle-blocked-${mode}`),
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, []);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`pr-watch-settle-unsettle-${mode}`),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        ...restart,
        commandId: CommandId.make(`pr-watch-settle-restart-${mode}`),
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
    }),
  );
  it.effect("archiving ends watches, and an archived thread cannot start one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-archive");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-archive-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-archive-project"),
        title: "Archive watched PR",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = {
        type: "thread.pull-request.watch" as const,
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" as const },
      };
      const watched = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
      );
      yield* orchestrator.dispatch({
        ...watch,
        commandId: CommandId.make("pr-watch-archive-start"),
      });
      assert.isTrue(yield* watched);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("pr-watch-archive"),
        threadId,
      });
      assert.isFalse(yield* watched);
      const refused = yield* orchestrator
        .dispatch({ ...watch, commandId: CommandId.make("pr-watch-archive-restart") })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("pr-watch-unarchive"),
        threadId,
      });
      assert.isFalse(yield* watched);
    }),
  );
  it.effect.each([
    { reason: "failed", activityFails: false },
    { reason: "not-found", activityFails: false },
    { reason: "failed", activityFails: true },
    { reason: "not-found", activityFails: true },
    { reason: "forbidden", activityFails: true },
  ] as const)(
    "handles repeated host read failures: $reason (activity fails: $activityFails)",
    ({ reason, activityFails }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(
          `runtime-pull-request-watch-unreadable-${reason}-${activityFails}`,
        );
        const projectId = ProjectId.make(`pr-watch-unreadable-project-${reason}-${activityFails}`);
        yield* seedProject({
          projectId,
          title: "Watch unreadable",
          workspaceRoot: "/workspace/watch-unreadable",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-unreadable-create-${reason}-${activityFails}`),
          threadId,
          projectId,
          title: "Watch unreadable",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-unreadable-start-${reason}-${activityFails}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 8,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/8", source: "agent" },
        });
        let disconnected = false;
        let passed = false;
        let genericFailure = false;
        const activityFailures = yield* Queue.unbounded<void>();
        const readFailure = (operation: string, failure: "failed" | "not-found" | "forbidden") =>
          new PullRequestOperationError({
            operation,
            detail: "host read failed",
            cause: new PullRequestProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation,
              reason: failure,
              detail: "host read failed",
            }),
          });
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                watchFingerprint: () => Effect.succeed(null),
                detail: () =>
                  genericFailure
                    ? Effect.die("host read failed")
                    : disconnected
                      ? (activityFails ? Queue.take(activityFailures) : Effect.void).pipe(
                          Effect.andThen(Effect.fail(readFailure("detail", reason))),
                        )
                      : Effect.succeed({
                          ...watchedPullRequestDetail({
                            projectId,
                            number: 8,
                            at: "2026-10-02T12:00:00.000Z",
                          }),
                          headSha: "abc1234def",
                          checks: [
                            {
                              name: "test",
                              status: passed ? ("success" as const) : ("pending" as const),
                              description: null,
                              url: null,
                              required: true,
                            },
                          ],
                        }),
                activity: () =>
                  disconnected && activityFails
                    ? Queue.offer(activityFailures, undefined).pipe(
                        Effect.andThen(Effect.fail(readFailure("activity", "failed"))),
                      )
                    : Effect.succeed({
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
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
        const summaries = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
        );
        yield* sweep;
        assert.deepEqual(yield* summaries, []);
        disconnected = true;
        for (let pass = 0; pass < 15; pass += 1) {
          genericFailure = reason === "failed" && (pass === 0 || (pass >= 2 && pass <= 8));
          yield* TestClock.adjust("2 minutes");
          yield* sweep;
        }

        const thread = yield* orchestrator.getThreadShell(threadId);
        if (reason !== "failed") {
          assert.isUndefined(thread?.pullRequests?.[0]?.watch);
          assert.deepEqual(yield* summaries, ["#8: stopped watching, could not read it"]);
          return;
        }
        assert.isDefined(thread?.pullRequests?.[0]?.watch);
        assert.deepEqual(yield* summaries, []);
        disconnected = false;
        genericFailure = false;
        passed = true;
        yield* sweep;
        assert.deepEqual(yield* summaries, ["#8: checks passed"]);
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.deepEqual(yield* summaries, ["#8: checks passed"]);
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-unreadable-stop-${reason}-${activityFails}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 8,
          watching: false,
        });
        yield* worker.drain();
      }),
  );
  it.effect("wakes once for a state it reported, across a restart and a new watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-told");
      const projectId = ProjectId.make("pr-watch-told-project");
      yield* seedProject({
        projectId,
        title: "Watch told",
        workspaceRoot: "/workspace/watch-told",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-told-create"),
        threadId,
        projectId,
        title: "Watch told",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-told-${id}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let headSha = "ad70160aaa";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks: ["lint", "test"].map((name) => ({
                name,
                status: "success" as const,
                description: null,
                url: null,
                required: true,
              })),
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
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      yield* watch(false, "stop");
      yield* watch(true, "again");
      yield* restarted.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      headSha = "bbbbbbbbbb";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      yield* watch(false, "end");
    }),
  );
  it.effect("finishes owed checks once after pending sweeps, a restart, and a re-watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-owed");
      const projectId = ProjectId.make("pr-watch-owed-project");
      yield* seedProject({
        projectId,
        title: "Watch owed",
        workspaceRoot: "/workspace/watch-owed",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-owed-create"),
        threadId,
        projectId,
        title: "Watch owed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-owed-${id}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let remainingStatus: "pending" | "success" = "pending";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha: "ad70160aaa",
              checks: ["lint", "test"].map((name) => ({
                name,
                status: name === "test" ? remainingStatus : ("success" as const),
                description: null,
                url: null,
                required: name === "lint",
              })),
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
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        ["test"],
      );
      // The fresh reactor reloads the nonempty obligation from the persisted watch.
      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      // A new watch on the same pull request knows what the last one told.
      yield* watch(false, "stop");
      yield* watch(true, "again");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        ["test"],
      );
      remainingStatus = "success";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        [],
      );
      yield* watch(false, "end");
    }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
});
