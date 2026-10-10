import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type GitRunStackedActionInput,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TaskGraphPeers from "./TaskGraphPeers.ts";
import * as TaskGraphService from "./TaskGraphService.ts";

const PARENT = ThreadId.make("thread-parent");

interface Harness {
  readonly launches: Queue.Queue<ThreadLaunch.ThreadLaunchInput>;
  readonly gitActions: Array<GitRunStackedActionInput>;
  readonly interrupted: Array<ThreadId>;
  /** Commands the service dispatched to threads, such as arming usage limit recovery. */
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  /** Replaces a node thread's projection, then emits a run event with `status`. */
  readonly setThread: (
    threadId: ThreadId,
    projection: OrchestrationV2ThreadProjection,
    status: string,
  ) => Effect.Effect<void>;
  readonly report: Deferred.Deferred<string>;
  /**
   * Sets a node thread's latest run, completed by default, with a reply on a
   * branch, then emits the run event.
   */
  readonly finish: (
    launch: ThreadLaunch.ThreadLaunchInput,
    result: { readonly reply: string; readonly branch: string; readonly status?: string },
  ) => Effect.Effect<void>;
}

const projection = (input: {
  readonly id: ThreadId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runStatus?: string;
  readonly reply?: string;
}) =>
  ({
    thread: {
      id: input.id,
      projectId: "project-1",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      branch: input.branch,
      worktreePath: input.worktreePath,
    },
    runs: input.runStatus === undefined ? [] : [{ status: input.runStatus, ordinal: 1 }],
    messages: input.reply === undefined ? [] : [{ role: "assistant", text: input.reply }],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

/** Builds the service against in-memory SQLite and recording fakes for everything it drives. */
const withService = <A, E>(
  body: (
    service: TaskGraphService.TaskGraphService["Service"],
    harness: Harness,
  ) => Effect.Effect<A, E>,
  peers: Layer.Layer<TaskGraphPeers.TaskGraphPeers> = TaskGraphPeers.layerNone,
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<ThreadLaunch.ThreadLaunchInput>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const report = yield* Deferred.make<string>();
    const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
      [PARENT, projection({ id: PARENT, branch: "main", worktreePath: null })],
    ]);
    const gitActions: Array<GitRunStackedActionInput> = [];
    const interrupted: Array<ThreadId> = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];

    const harness: Harness = {
      launches,
      gitActions,
      interrupted,
      dispatched,
      setThread: (threadId, next, status) =>
        Effect.gen(function* () {
          projections.set(threadId, next);
          yield* Queue.offer(events, {
            type: "run.updated",
            threadId,
            payload: { status },
          } as unknown as OrchestrationV2DomainEvent);
        }),
      report,
      finish: (launch, result) =>
        Effect.gen(function* () {
          const threadId = launch.threadId!;
          projections.set(
            threadId,
            projection({
              id: threadId,
              branch: result.branch,
              worktreePath: `/worktrees/${result.branch}`,
              runStatus: result.status ?? "completed",
              reply: result.reply,
            }),
          );
          yield* Queue.offer(events, {
            type: "run.updated",
            threadId,
            payload: { status: result.status ?? "completed" },
          } as unknown as OrchestrationV2DomainEvent);
        }),
    };

    const layer = TaskGraphService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: (input) =>
              Queue.offer(launches, input).pipe(
                Effect.as({
                  threadId: input.threadId!,
                  projection: projection({ id: input.threadId!, branch: null, worktreePath: null }),
                  resumed: false,
                }),
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadProjection: (threadId) =>
              Effect.suspend(() => {
                const found = projections.get(threadId);
                return found === undefined
                  ? Effect.die(`no thread ${threadId}`)
                  : Effect.succeed(found);
              }),
            streamDomainEvents: Stream.fromQueue(events),
            sendToThread: (input) =>
              Deferred.succeed(report, input.text).pipe(Effect.as({} as never)),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return {} as never;
              }),
            interruptThread: (input) =>
              Effect.sync(() => {
                interrupted.push(input.threadId);
                return { type: "no_active_run" as const };
              }),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            runStackedAction: (input) =>
              Effect.sync(() => {
                gitActions.push(input);
                return {
                  pr:
                    input.action === "commit_push_pr"
                      ? { status: "created", url: `https://pr/${input.cwd}` }
                      : {},
                } as never;
              }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(HostResources.HostResources)({
            read: Effect.succeed({
              sampledAt: 0,
              cpuUtilization: 0.1,
              cpuCount: 8,
              availableMemoryBytes: 8e9,
              totalMemoryBytes: 16e9,
            }),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-local")),
          }),
          // Linking the created PR is best effort; these fakes make it log and move on.
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          ServerSettings.layerTest({}),
          peers,
          Scheduler.layer,
          NodeCrypto.layer,
        ),
      ),
    );
    return yield* TaskGraphService.TaskGraphService.pipe(
      Effect.flatMap((service) => body(service, harness)),
      Effect.provide(layer),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const node = (key: string, dependsOn: ReadonlyArray<string> = []) => ({
  key,
  title: key,
  prompt: `Do ${key}.`,
  dependsOn,
});

it.effect("fans out, merges, opens a PR at the end, and reports to the proposing thread", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      yield* service.create({
        threadId: PARENT,
        title: "Security audit",
        nodes: [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])],
        run: true,
      });

      const a = yield* Queue.take(harness.launches);
      assert.equal(a.title, "a");
      // The node's thread does not exist yet; reuseExistingThread would make the launcher
      // look for it and fail every launch.
      assert.isUndefined(a.reuseExistingThread);
      assert.isDefined(a.threadId);
      assert.deepEqual(a.workspaceStrategy, { type: "worktree", baseRef: "main" });
      yield* harness.finish(a, { reply: "a found two issues", branch: "t3/a" });

      // Both branches of the fan-out start from a's branch once a succeeds.
      const fanOut = [yield* Queue.take(harness.launches), yield* Queue.take(harness.launches)];
      assert.deepEqual(fanOut.map((launch) => launch.title).toSorted(), ["b", "c"]);
      for (const launch of fanOut) {
        assert.deepEqual(launch.workspaceStrategy, { type: "worktree", baseRef: "t3/a" });
        assert.include(launch.initialMessage!.text, "a found two issues");
        yield* harness.finish(launch, {
          reply: `${launch.title} fixed`,
          branch: `t3/${launch.title}`,
        });
      }

      const d = yield* Queue.take(harness.launches);
      assert.equal(d.title, "d");
      assert.deepEqual(d.workspaceStrategy, { type: "worktree", baseRef: "t3/b" });
      assert.include(d.initialMessage!.text, "- t3/c (from 'c')");
      assert.include(d.initialMessage!.text, "b fixed");
      assert.include(d.initialMessage!.text, "c fixed");
      yield* harness.finish(d, { reply: "merged", branch: "t3/d" });

      const report = yield* Deferred.await(harness.report);
      assert.include(report, 'Task graph "Security audit" finished: succeeded.');
      assert.include(report, "PR: https://pr//worktrees/t3/d");
      // Only the branch end opens a PR, so it targets the graph base and carries all the work.
      assert.equal(
        harness.gitActions.find((action) => action.action === "commit_push_pr")?.baseBranch,
        "main",
      );
      // Inner nodes commit so dependents can branch from them; only the end opens a PR.
      assert.deepEqual(
        harness.gitActions.map((action) => [action.cwd, action.action]),
        [
          ["/worktrees/t3/a", "commit"],
          ...fanOut
            .map((launch) => [`/worktrees/t3/${launch.title}`, "commit"])
            .toSorted(([left], [right]) => left!.localeCompare(right!)),
          ["/worktrees/t3/d", "commit_push_pr"],
        ].toSorted(([left], [right]) => left!.localeCompare(right!)),
      );
    }),
  ),
);

it.effect("cutting off a running branch stops its thread and skips what depends on it", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const graph = yield* service.create({
        threadId: PARENT,
        title: "Features",
        nodes: [node("a"), node("b", ["a"])],
        run: true,
      });
      const a = yield* Queue.take(harness.launches);

      const edited = yield* service.edit(graph.id, [{ type: "cancel_branch", key: "a" }]);

      assert.deepEqual(harness.interrupted, [a.threadId]);
      assert.deepEqual(
        edited.nodes.map((graphNode) => graphNode.status),
        ["cancelled", "cancelled"],
      );
      assert.equal(edited.status, "cancelled");
      assert.include(yield* Deferred.await(harness.report), "finished: cancelled");
    }),
  ),
);

it.effect("a draft waits for run, and edits before it starts change what launches", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const draft = yield* service.create({
        threadId: PARENT,
        title: "Plan",
        nodes: [node("a")],
        run: false,
      });
      assert.equal(draft.status, "draft");
      assert.equal(yield* Queue.size(harness.launches), 0);

      yield* service.edit(draft.id, [
        { type: "update_node", key: "a", prompt: "Do a differently." },
        { type: "add_node", node: node("b") },
      ]);
      yield* service.run(draft.id);

      const launched = [yield* Queue.take(harness.launches), yield* Queue.take(harness.launches)];
      assert.deepEqual(launched.map((launch) => launch.title).toSorted(), ["a", "b"]);
      assert.include(
        launched.find((launch) => launch.title === "a")!.initialMessage!.text,
        "Do a differently.",
      );
    }),
  ),
);

it.effect("places a node on a peer with more free capacity and pushes local branches for it", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<TaskGraphPeers.PeerNodeStart>();
    const peers = Layer.succeed(
      TaskGraphPeers.TaskGraphPeers,
      TaskGraphPeers.TaskGraphPeers.of({
        hasPeers: Effect.succeed(true),
        // A much bigger idle machine: it wins the load-balancing score.
        candidates: () =>
          Effect.succeed([
            {
              environmentId: EnvironmentId.make("env-peer"),
              resources: {
                sampledAt: 0,
                cpuUtilization: 0,
                cpuCount: 64,
                availableMemoryBytes: 100e9,
                totalMemoryBytes: 128e9,
              },
              // it.effect runs on a test clock that starts at 0.
              receivedAt: 0,
              weight: 50,
            },
          ]),
        startNode: (input) => Queue.offer(started, input).pipe(Effect.asVoid),
        track: () => Effect.void,
        interruptNode: () => Effect.void,
        completions: Stream.never,
        list: Effect.succeed({ peers: [] }),
        subscribe: Stream.never,
        add: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        setWeight: () => Effect.die("unused"),
      }),
    );
    yield* withService(
      (service) =>
        Effect.gen(function* () {
          yield* service.create({
            threadId: PARENT,
            title: "Spread",
            nodes: [node("a")],
            run: true,
          });
          const start = yield* Queue.take(started);
          assert.equal(start.environmentId, "env-peer");
          assert.deepEqual(start.workspaceStrategy, {
            type: "worktree",
            baseRef: "main",
            startFromOrigin: true,
          });
          // A branch end opens its PR from the peer.
          assert.deepEqual(start.delivery, { action: "commit_push_pr", baseBranch: "main" });
        }),
      peers,
    );
  }),
);

it.effect("follows a failed node that someone continues in its own thread", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const graph = yield* service.create({
        threadId: PARENT,
        title: "Roadmap",
        nodes: [node("a"), node("b", ["a"])],
        run: true,
      });
      const a = yield* Queue.take(harness.launches);
      yield* harness.finish(a, { reply: "crashed", branch: "t3/a", status: "failed" });
      assert.include(yield* Deferred.await(harness.report), "finished: failed");

      // The user sends a follow-up in a's thread and that run succeeds.
      yield* harness.finish(a, { reply: "", branch: "t3/a", status: "running" });
      yield* harness.finish(a, { reply: "fixed it", branch: "t3/a" });

      const b = yield* Queue.take(harness.launches);
      assert.equal(b.title, "b");
      assert.include(b.initialMessage!.text, "fixed it");
      const resumed = yield* service.get(graph.id);
      assert.equal(resumed.status, "running");
      assert.deepEqual(
        resumed.nodes.map((graphNode) => graphNode.status),
        ["succeeded", "running"],
      );
    }),
  ),
);

it.effect("stacks PRs, continues a worktree in place, and never commits project-folder work", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      yield* service.create({
        threadId: PARENT,
        title: "Stack",
        nodes: [
          { ...node("review"), workspace: "root" },
          { ...node("a", ["review"]), pullRequest: true },
          { ...node("a-tests", ["a"]), workspace: "dependency" },
          { ...node("b", ["a-tests"]), pullRequest: true },
        ],
        run: true,
      });

      const review = yield* Queue.take(harness.launches);
      assert.deepEqual(review.workspaceStrategy, { type: "root" });
      yield* harness.finish(review, { reply: "read it all", branch: "main" });

      const a = yield* Queue.take(harness.launches);
      assert.deepEqual(a.workspaceStrategy, { type: "worktree", baseRef: "main" });
      yield* harness.finish(a, { reply: "layer one", branch: "t3/a" });

      const aTests = yield* Queue.take(harness.launches);
      assert.deepEqual(aTests.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/worktrees/t3/a",
        branch: "t3/a",
      });
      yield* harness.finish(aTests, { reply: "tests added", branch: "t3/a" });

      const b = yield* Queue.take(harness.launches);
      yield* harness.finish(b, { reply: "layer two", branch: "t3/b" });
      yield* Deferred.await(harness.report);

      // The review committed nothing; each layer's PR targets the layer below it.
      assert.deepEqual(
        harness.gitActions.map((action) => [action.cwd, action.action, action.baseBranch]),
        [
          ["/worktrees/t3/a", "commit_push_pr", "main"],
          ["/worktrees/t3/a", "commit", undefined],
          ["/worktrees/t3/b", "commit_push_pr", "t3/a"],
        ],
      );
    }),
  ),
);

/** A thread whose only run stopped on a usage limit that resets at `resetAt`. */
const limitedThread = (threadId: ThreadId, resetAt: string) =>
  ({
    ...projection({ id: threadId, branch: "t3/a", worktreePath: "/worktrees/t3/a" }),
    runs: [
      {
        id: "run-1",
        status: "failed",
        ordinal: 1,
        rootNodeId: "node-1",
        startedAt: DateTime.makeUnsafe(0),
        completedAt: DateTime.makeUnsafe(1_000),
      },
    ],
    turnItems: [
      {
        id: "item-1",
        type: "error",
        status: "failed",
        runId: "run-1",
        nodeId: "node-1",
        ordinal: 1,
        updatedAt: DateTime.makeUnsafe(1_000),
        failure: { class: "usage_limit", message: "Limit reached", resetAt },
      },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

it.effect("holds a node stopped by a usage limit and continues it on its thread at the reset", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const graph = yield* service.create({
        threadId: PARENT,
        title: "Limits",
        nodes: [node("a"), node("b", ["a"])],
        run: true,
      });
      const a = yield* Queue.take(harness.launches);
      const resetAt = "2026-10-10T05:00:00.000Z";
      yield* harness.setThread(a.threadId!, limitedThread(a.threadId!, resetAt), "failed");

      // The arm command is the last thing the service does for the limited run.
      while (harness.dispatched.length === 0) yield* Effect.yieldNow;
      assert.deepEqual(harness.dispatched[0], {
        type: "thread.metadata.update",
        commandId: `task-graph-limit-arm:${a.threadId}:run-1`,
        threadId: a.threadId,
        limitRecovery: { runId: "run-1", resetAt, autoResume: true },
      } as never);
      const waiting = (yield* service.get(graph.id)).nodes[0]!;
      assert.deepEqual(
        [waiting.status, waiting.waitUntil, waiting.waitReason],
        ["waiting", resetAt, "usage_limit"],
      );

      // At the reset, recovery starts a new run on the same thread, which then succeeds.
      yield* harness.setThread(a.threadId!, limitedThread(a.threadId!, resetAt), "running");
      yield* harness.finish(a, { reply: "done after reset", branch: "t3/a" });
      const b = yield* Queue.take(harness.launches);
      assert.include(b.initialMessage!.text, "done after reset");
    }),
  ),
);

it.effect("waits for a node's start time", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const graph = yield* service.create({
        threadId: PARENT,
        title: "Overnight",
        nodes: [{ ...node("a"), startAt: "1970-01-01T00:01:00.000Z" }],
        run: true,
      });
      assert.deepEqual(
        [(yield* service.get(graph.id)).nodes[0]!.status, yield* Queue.size(harness.launches)],
        ["waiting", 0],
      );
      yield* TestClock.adjust("2 minutes");
      const a = yield* Queue.take(harness.launches);
      assert.equal(a.title, "a");
    }),
  ),
);
