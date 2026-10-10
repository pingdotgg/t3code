import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type GitRunStackedActionInput,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
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
  readonly report: Deferred.Deferred<string>;
  /** Marks a node thread's run finished with a reply on a branch, then emits the run event. */
  readonly finish: (
    launch: ThreadLaunch.ThreadLaunchInput,
    result: { readonly reply: string; readonly branch: string },
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

    const harness: Harness = {
      launches,
      gitActions,
      interrupted,
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
              runStatus: "completed",
              reply: result.reply,
            }),
          );
          yield* Queue.offer(events, {
            type: "run.updated",
            threadId,
            payload: { status: "completed" },
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
          assert.equal(start.baseRef, "main");
          // A branch end opens its PR from the peer.
          assert.equal(start.delivery, "commit_push_pr");
        }),
      peers,
    );
  }),
);
