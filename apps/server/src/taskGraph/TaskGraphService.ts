import {
  CommandId,
  EnvironmentId,
  MessageId,
  TaskGraph,
  TaskGraphError,
  TaskGraphId,
  ThreadId,
  type HostResourcesSnapshot,
  type TaskGraphCreateInput,
  type TaskGraphEdit,
  type TaskGraphListResult,
  type TaskGraphNode,
} from "@t3tools/contracts";
import {
  applyTaskGraphEdits,
  buildTaskGraphNodePrompt,
  deriveTaskGraphStatus,
  isActiveTaskGraphNodeStatus,
  isTerminalTaskGraphNodeStatus,
  newTaskGraphNode,
  readyTaskGraphNodes,
  resumeTaskGraphNode,
  skipUnreachableTaskGraphNodes,
  taskGraphNodeOpensPullRequest,
  taskGraphNodeSummary,
  validateTaskGraphNodes,
} from "@t3tools/shared/taskGraph";
import { chooseLoadBalancedEnvironment } from "@t3tools/shared/loadBalancing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../git/linkCreatedPullRequest.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TaskGraphPeers from "./TaskGraphPeers.ts";

/**
 * Runs task graphs: plans of agent tasks with dependencies, where each node is
 * its own thread in its own worktree. The orchestrator stays unaware of graphs;
 * this service launches node threads through `ThreadLaunchService`, reads their
 * outcome from the domain event stream, and opens a pull request per branch end.
 *
 * Every graph change goes through one lock and is written whole, so a crash
 * leaves either the old graph or the new one. Thread launches and git work run
 * outside the lock against state already recorded as `running`/`delivering`,
 * and are idempotent by command id so recovery can repeat them.
 */
export class TaskGraphService extends Context.Service<
  TaskGraphService,
  {
    readonly create: (input: TaskGraphCreateInput) => Effect.Effect<TaskGraph, TaskGraphError>;
    readonly get: (graphId: TaskGraphId) => Effect.Effect<TaskGraph, TaskGraphError>;
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<TaskGraph>, TaskGraphError>;
    /** Emits the thread's graphs on subscribe and again after each change to one of them. */
    readonly subscribeThread: (
      threadId: ThreadId,
    ) => Stream.Stream<TaskGraphListResult, TaskGraphError>;
    readonly edit: (
      graphId: TaskGraphId,
      edits: ReadonlyArray<TaskGraphEdit>,
    ) => Effect.Effect<TaskGraph, TaskGraphError>;
    readonly run: (graphId: TaskGraphId) => Effect.Effect<TaskGraph, TaskGraphError>;
    readonly cancel: (graphId: TaskGraphId) => Effect.Effect<TaskGraph, TaskGraphError>;
    /** A node that ran on a peer finished there; recorded like a local node's end. */
    readonly completeRemoteNode: (input: {
      readonly threadId: ThreadId;
      readonly outcome: NodeOutcome;
    }) => Effect.Effect<void>;
  }
>()("t3/taskGraph/TaskGraphService") {}

export type NodeOutcome =
  | {
      readonly type: "succeeded";
      readonly summary: string | null;
      readonly branch: string | null;
      readonly pullRequestUrl?: string | null;
    }
  | { readonly type: "failed" | "cancelled"; readonly error: string };

/** Above this the host is too busy to take another node; matches client load balancing. */
const MAX_CPU_UTILIZATION = 0.95;
const MIN_AVAILABLE_MEMORY_FRACTION = 0.05;

export function hostHasCapacity(snapshot: HostResourcesSnapshot): boolean {
  if (snapshot.cpuUtilization !== null && snapshot.cpuUtilization >= MAX_CPU_UTILIZATION) {
    return false;
  }
  return (
    snapshot.totalMemoryBytes <= 0 ||
    snapshot.availableMemoryBytes / snapshot.totalMemoryBytes > MIN_AVAILABLE_MEMORY_FRACTION
  );
}

/** This machine's weight against its peers' (peers default to the same). */
const LOCAL_WEIGHT = 50;

const peerDelivery = (graph: TaskGraph, node: TaskGraphNode): TaskGraphPeers.PeerDelivery =>
  taskGraphNodeOpensPullRequest(graph.nodes, node) ? "commit_push_pr" : "commit_push";

const decodeGraphJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskGraph));
const encodeGraphJson = Schema.encodeSync(Schema.fromJsonString(TaskGraph));

interface TaskGraphRow {
  readonly graph_json: string;
}

const graphError = (message: string, graphId?: TaskGraphId, cause?: unknown) =>
  new TaskGraphError({
    message,
    ...(graphId === undefined ? {} : { graphId }),
    ...(cause === undefined ? {} : { cause }),
  });

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));

/** The message the proposing thread receives when its graph ends. */
export function taskGraphReport(graph: TaskGraph): string {
  const lines = graph.nodes.map((node) => {
    const pr = node.pullRequestResult;
    const prText =
      pr === null
        ? ""
        : pr.status === "opened"
          ? ` — PR: ${pr.url ?? "opened"}`
          : ` — PR failed: ${pr.error ?? "unknown error"}`;
    const detail = node.status === "succeeded" ? "" : node.error === null ? "" : ` (${node.error})`;
    return `- ${node.key} "${node.title}": ${node.status}${detail}${prText}`;
  });
  return [`Task graph "${graph.title}" finished: ${graph.status}.`, ...lines].join("\n");
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const hostResources = yield* HostResources.HostResources;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peers = yield* TaskGraphPeers.TaskGraphPeers;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const localEnvironmentId = yield* environment.getEnvironmentId;

  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const changes = yield* PubSub.unbounded<ThreadId>();
  /** Node threads still running locally, so run events map back to their node. */
  const nodeByThread = new Map<ThreadId, { graphId: TaskGraphId; key: string }>();
  /** Threads of local nodes that failed or were cancelled, in case someone continues them. */
  const endedByThread = new Map<ThreadId, { graphId: TaskGraphId; key: string }>();

  const readGraph = (graphId: TaskGraphId) =>
    sql<TaskGraphRow>`SELECT graph_json FROM task_graphs WHERE graph_id = ${graphId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : decodeGraphJson(rows[0].graph_json),
      ),
      Effect.mapError((cause) => graphError("Could not read task graph.", graphId, cause)),
    );

  const requireGraph = (graphId: TaskGraphId) =>
    readGraph(graphId).pipe(
      Effect.flatMap((graph) =>
        graph === null
          ? Effect.fail(graphError("Task graph not found.", graphId))
          : Effect.succeed(graph),
      ),
    );

  const readGraphs = (rows: ReadonlyArray<TaskGraphRow>) =>
    Effect.forEach(rows, (row) => decodeGraphJson(row.graph_json)).pipe(
      Effect.mapError((cause) => graphError("Could not read task graphs.", undefined, cause)),
    );

  const runningGraphs = sql<TaskGraphRow>`
    SELECT graph_json FROM task_graphs WHERE status = 'running' ORDER BY created_at
  `.pipe(
    Effect.mapError((cause) => graphError("Could not list task graphs.", undefined, cause)),
    Effect.flatMap(readGraphs),
  );

  /** Graphs a node may still come back to life in: anything not cancelled as a whole. */
  const resumableGraphs = sql<TaskGraphRow>`
    SELECT graph_json FROM task_graphs WHERE status IN ('running', 'failed') ORDER BY created_at
  `.pipe(
    Effect.mapError((cause) => graphError("Could not list task graphs.", undefined, cause)),
    Effect.flatMap(readGraphs),
  );

  const indexGraph = (graph: TaskGraph) => {
    for (const node of graph.nodes) {
      if (node.threadId === null) continue;
      const target = { graphId: graph.id, key: node.key };
      if (isActiveTaskGraphNodeStatus(node.status)) {
        nodeByThread.set(node.threadId, target);
      } else {
        nodeByThread.delete(node.threadId);
      }
      if (
        (node.status === "failed" || node.status === "cancelled") &&
        graph.status !== "cancelled" &&
        node.assignedEnvironmentId === localEnvironmentId
      ) {
        endedByThread.set(node.threadId, target);
      } else {
        endedByThread.delete(node.threadId);
      }
    }
  };

  /**
   * Someone continued a failed or cancelled node in its own thread. Follow
   * that run instead of leaving the node, and everything after it, stuck.
   */
  const resumeNode = (graphId: TaskGraphId, key: string) =>
    locked(
      Effect.gen(function* () {
        const graph = yield* requireGraph(graphId);
        if (graph.status === "cancelled") return;
        const nodes = resumeTaskGraphNode(graph.nodes, key);
        if (nodes === null) return;
        yield* writeGraph({ ...graph, status: "running", nodes });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not resume task graph node", {
          graphId,
          key,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Writes a graph after settling skips and status. Returns the stored graph. */
  const writeGraph = (graph: TaskGraph) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const nodes = skipUnreachableTaskGraphNodes(graph.nodes, now);
      const stored: TaskGraph = {
        ...graph,
        nodes,
        status: deriveTaskGraphStatus(graph.status, nodes),
        updatedAt: now,
      };
      yield* sql`
        INSERT INTO task_graphs (graph_id, project_id, thread_id, status, graph_json, created_at, updated_at)
        VALUES (${stored.id}, ${stored.projectId}, ${stored.threadId}, ${stored.status},
                ${encodeGraphJson(stored)}, ${stored.createdAt}, ${stored.updatedAt})
        ON CONFLICT (graph_id) DO UPDATE SET
          status = excluded.status,
          graph_json = excluded.graph_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError((cause) => graphError("Could not save task graph.", graph.id, cause)));
      indexGraph(stored);
      yield* PubSub.publish(changes, stored.threadId);
      return stored;
    });

  const updateNode = (
    graphId: TaskGraphId,
    key: string,
    update: (node: TaskGraphNode, graph: TaskGraph) => TaskGraphNode,
  ) =>
    locked(
      Effect.gen(function* () {
        const graph = yield* requireGraph(graphId);
        const before = graph.status;
        const stored = yield* writeGraph({
          ...graph,
          nodes: graph.nodes.map((node) => (node.key === key ? update(node, graph) : node)),
        });
        return { stored, finished: before === "running" && stored.status !== "running" };
      }),
    ).pipe(Effect.tap(({ stored, finished }) => (finished ? reportFinished(stored) : Effect.void)));

  /** Tells the proposing thread how its graph ended, queued behind any turn in progress. */
  const reportFinished = (graph: TaskGraph) =>
    threads
      .sendToThread({
        projectId: graph.projectId,
        commandId: CommandId.make(`task-graph-report:${graph.id}:${graph.updatedAt}`),
        threadId: graph.threadId,
        messageId: MessageId.make(`task-graph-report:${graph.id}:${graph.updatedAt}`),
        text: taskGraphReport(graph),
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not report finished task graph", {
            graphId: graph.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  // --- Finishing nodes -------------------------------------------------------

  /** Commits the node's work so dependents can branch from it, and opens its PR. */
  const deliver = (graph: TaskGraph, node: TaskGraphNode, worktreePath: string) =>
    Effect.gen(function* () {
      const opensPullRequest = taskGraphNodeOpensPullRequest(graph.nodes, node);
      // With peers paired, a dependent may run elsewhere and needs the branch on origin.
      const push = yield* peers.hasPeers;
      const result = yield* git.runStackedAction({
        actionId: `task-graph:${graph.id}:${node.key}:${node.threadId}`,
        cwd: worktreePath,
        action: opensPullRequest ? "commit_push_pr" : push ? "commit_push" : "commit",
        ...(node.threadId === null ? {} : { threadId: node.threadId }),
        projectId: graph.projectId,
      });
      if (opensPullRequest && node.threadId !== null) {
        yield* linkCreatedPullRequest({
          threadId: node.threadId,
          result,
          commandId: Effect.succeed(CommandId.make(`task-graph-pr-link:${node.threadId}`)),
        }).pipe(
          Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
          Effect.provideService(ProjectService.ProjectService, projects),
        );
      }
      return opensPullRequest
        ? ({ status: "opened", url: result.pr.url ?? null, error: null } as const)
        : null;
    });

  const finishLocalNode = (graphId: TaskGraphId, key: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(threadId);
      // A follow-up the user sent to the node thread keeps the node running.
      if (ThreadManagement.latestActiveRun(projection) !== undefined) return;
      const run = ThreadManagement.latestRun(projection);
      nodeByThread.delete(threadId);
      if (run === undefined || run.status !== "completed") {
        const status =
          run?.status === "cancelled" || run?.status === "interrupted" ? "cancelled" : "failed";
        yield* updateNode(graphId, key, (node, _graph) =>
          node.status === "running"
            ? {
                ...node,
                status,
                error:
                  run === undefined
                    ? "The node's thread has no run."
                    : `The node's run ${run.status}.`,
              }
            : node,
        ).pipe(Effect.tap(() => advance));
        return;
      }
      const lastReply = projection.messages.findLast(
        (message) => message.role === "assistant" && message.text.trim().length > 0,
      );
      const { stored } = yield* updateNode(graphId, key, (node) =>
        node.status === "running"
          ? {
              ...node,
              status: "delivering",
              branch: projection.thread.branch,
              summary: lastReply === undefined ? null : taskGraphNodeSummary(lastReply.text),
            }
          : node,
      );
      const node = stored.nodes.find((candidate) => candidate.key === key);
      if (node === undefined || node.status !== "delivering") return;
      const worktreePath = projection.thread.worktreePath;
      const delivered =
        worktreePath === null
          ? Exit.succeed(null)
          : yield* Effect.exit(deliver(stored, node, worktreePath));
      const completedAt = yield* nowIso;
      yield* updateNode(graphId, key, (current) =>
        current.status !== "delivering"
          ? current
          : Exit.isSuccess(delivered)
            ? { ...current, status: "succeeded", pullRequestResult: delivered.value, completedAt }
            : taskGraphNodeOpensPullRequest(stored.nodes, current)
              ? {
                  // The work itself is done; only the PR failed, so dependents still run.
                  ...current,
                  status: "succeeded",
                  pullRequestResult: {
                    status: "failed",
                    url: null,
                    error: errorMessage(delivered.cause),
                  },
                  completedAt,
                }
              : {
                  ...current,
                  status: "failed",
                  error: `Could not commit the node's work: ${errorMessage(delivered.cause)}`,
                  completedAt,
                },
      );
      yield* advance;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not finish task graph node", {
          graphId,
          key,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const completeRemoteNode: TaskGraphService["Service"]["completeRemoteNode"] = ({
    threadId,
    outcome,
  }) =>
    Effect.gen(function* () {
      const target = nodeByThread.get(threadId);
      if (target === undefined) return;
      nodeByThread.delete(threadId);
      const completedAt = yield* nowIso;
      yield* updateNode(target.graphId, target.key, (node) => {
        if (!isActiveTaskGraphNodeStatus(node.status)) return node;
        if (outcome.type !== "succeeded") {
          return { ...node, status: outcome.type, error: outcome.error, completedAt };
        }
        return {
          ...node,
          status: "succeeded",
          summary: outcome.summary === null ? null : taskGraphNodeSummary(outcome.summary),
          branch: outcome.branch,
          pullRequestResult:
            outcome.pullRequestUrl === undefined
              ? null
              : { status: "opened", url: outcome.pullRequestUrl, error: null },
          completedAt,
        };
      });
      yield* advance;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record remote task graph node", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // --- Starting nodes --------------------------------------------------------

  /**
   * Where a ready node runs: its pinned machine, or whichever of this machine
   * and its peers has the most free capacity, scored like client load balancing.
   * Null when nowhere has room; the node waits for the next pass.
   */
  const placeNode = (
    graph: TaskGraph,
    node: TaskGraphNode,
    local: { readonly resources: HostResourcesSnapshot; readonly hasRoom: boolean },
    maxNodes: number,
  ): Effect.Effect<EnvironmentId | null> =>
    Effect.gen(function* () {
      if (node.environmentId === localEnvironmentId) {
        return local.hasRoom ? localEnvironmentId : null;
      }
      const remote = yield* peers.candidates({
        projectId: graph.projectId,
        maxNodesPerPeer: maxNodes,
      });
      if (node.environmentId !== null) {
        return remote.some((candidate) => candidate.environmentId === node.environmentId)
          ? node.environmentId
          : null;
      }
      if (remote.length === 0) return local.hasRoom ? localEnvironmentId : null;
      const now = yield* Clock.currentTimeMillis;
      const chosen = chooseLoadBalancedEnvironment(
        [
          ...(local.hasRoom
            ? [
                {
                  environmentId: localEnvironmentId,
                  resources: local.resources,
                  receivedAt: now,
                  weight: LOCAL_WEIGHT,
                },
              ]
            : []),
          ...remote,
        ],
        now,
      );
      // The scorer skips a machine without a CPU sample yet; this one can still take work.
      if (chosen === null) return local.hasRoom ? localEnvironmentId : null;
      return EnvironmentId.make(chosen);
    });

  const launchNode = (graph: TaskGraph, node: TaskGraphNode) =>
    Effect.gen(function* () {
      const threadId = node.threadId!;
      const parent = yield* threads.getThreadProjection(graph.threadId);
      const firstDependency = graph.nodes.find((candidate) => candidate.key === node.dependsOn[0]);
      const baseRef = firstDependency?.branch ?? graph.baseRef;
      const prompt = buildTaskGraphNodePrompt(graph, node);
      const modelSelection = node.modelSelection ?? parent.thread.modelSelection;
      if (node.assignedEnvironmentId !== localEnvironmentId) {
        yield* peers.startNode({
          environmentId: node.assignedEnvironmentId!,
          graph,
          node,
          threadId,
          baseRef,
          prompt,
          modelSelection,
          runtimeMode: parent.thread.runtimeMode,
          delivery: peerDelivery(graph, node),
        });
        return;
      }
      // A dependency that ran on a peer pushed its branch; it exists here only on origin.
      const fromPeer =
        firstDependency !== undefined &&
        firstDependency.assignedEnvironmentId !== localEnvironmentId;
      yield* launcher.launch({
        commandId: CommandId.make(`task-graph-launch:${threadId}`),
        threadId,
        projectId: graph.projectId,
        title: node.title,
        modelSelection,
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          baseRef,
          ...(fromPeer ? { startFromOrigin: true } : {}),
        },
        initialMessage: {
          messageId: MessageId.make(`task-graph-message:${threadId}`),
          senderThreadId: graph.threadId,
          text: prompt,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const completedAt = yield* nowIso;
          nodeByThread.delete(node.threadId!);
          yield* updateNode(graph.id, node.key, (current) =>
            current.status === "running"
              ? {
                  ...current,
                  status: "failed",
                  error: `Could not start the node: ${errorMessage(cause)}`,
                  completedAt,
                }
              : current,
          );
        }),
      ),
    );

  /**
   * Starts every node that is ready and fits: under the environment's
   * concurrency limit, and on a machine that is not overloaded. Nodes that do
   * not fit wait for the next scheduler tick or the next node to finish.
   */
  const advance: Effect.Effect<void> = Effect.gen(function* () {
    const { taskGraphMaxConcurrentNodes } = yield* settings.getSettings;
    const toLaunch = yield* locked(
      Effect.gen(function* () {
        const graphs = yield* runningGraphs;
        let active = graphs
          .flatMap((graph) => graph.nodes)
          .filter(
            (node) =>
              isActiveTaskGraphNodeStatus(node.status) &&
              node.assignedEnvironmentId === localEnvironmentId,
          ).length;
        const host = yield* hostResources.read;
        const hostFree = hostHasCapacity(host);
        const started: Array<{ graph: TaskGraph; node: TaskGraphNode }> = [];
        for (const graph of graphs) {
          const ready = readyTaskGraphNodes(
            skipUnreachableTaskGraphNodes(graph.nodes, yield* nowIso),
          );
          const assigned = new Map<string, TaskGraphNode>();
          for (const node of ready) {
            const environmentId = yield* placeNode(
              graph,
              node,
              { resources: host, hasRoom: hostFree && active < taskGraphMaxConcurrentNodes },
              taskGraphMaxConcurrentNodes,
            );
            if (environmentId === null) continue;
            if (environmentId === localEnvironmentId) active += 1;
            assigned.set(node.key, {
              ...node,
              status: "running",
              assignedEnvironmentId: environmentId,
              threadId: ThreadId.make(`task-graph-node:${yield* crypto.randomUUIDv4}`),
              startedAt: yield* nowIso,
            });
          }
          // Write even with nothing to start: skips may have settled the graph.
          const stored = yield* writeGraph({
            ...graph,
            nodes: graph.nodes.map((node) => assigned.get(node.key) ?? node),
          });
          if (stored.status !== "running") yield* reportFinished(stored).pipe(Effect.forkDetach);
          for (const node of assigned.values()) started.push({ graph: stored, node });
        }
        return started;
      }),
    );
    yield* Effect.forEach(toLaunch, ({ graph, node }) => launchNode(graph, node), {
      concurrency: "unbounded",
      discard: true,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not advance task graphs", { cause: Cause.pretty(cause) }),
    ),
  );

  const stopNodes = (graph: TaskGraph, nodes: ReadonlyArray<TaskGraphNode>) =>
    Effect.forEach(
      nodes,
      (node) => {
        if (node.threadId === null) return Effect.void;
        nodeByThread.delete(node.threadId);
        if (
          node.assignedEnvironmentId !== localEnvironmentId &&
          node.assignedEnvironmentId !== null
        ) {
          return peers.interruptNode({
            environmentId: node.assignedEnvironmentId,
            threadId: node.threadId,
          });
        }
        return threads
          .interruptThread({
            projectId: graph.projectId,
            commandId: CommandId.make(`task-graph-stop:${node.threadId}`),
            threadId: node.threadId,
            reason: "The task graph branch was cancelled.",
          })
          .pipe(Effect.asVoid);
      },
      { discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not stop cancelled task graph nodes", {
          graphId: graph.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // --- Public API -------------------------------------------------------------

  const create: TaskGraphService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const parent = yield* threads
        .getThreadProjection(input.threadId)
        .pipe(
          Effect.mapError((cause) => graphError("Could not read the thread.", undefined, cause)),
        );
      const nodes = input.nodes.map(newTaskGraphNode);
      const invalid = validateTaskGraphNodes(nodes);
      if (invalid !== null) return yield* graphError(invalid);
      const { taskGraphAutoRun } = yield* settings.getSettings.pipe(
        Effect.mapError((cause) => graphError("Could not read settings.", undefined, cause)),
      );
      const now = yield* nowIso;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => graphError("Could not create task graph id.", undefined, cause)),
      );
      const graph = yield* locked(
        writeGraph({
          id: TaskGraphId.make(`task-graph:${uuid}`),
          projectId: parent.thread.projectId,
          threadId: parent.thread.id,
          title: input.title,
          baseRef: input.baseRef ?? parent.thread.branch ?? "HEAD",
          status: (input.run ?? taskGraphAutoRun) ? "running" : "draft",
          nodes,
          createdAt: now,
          updatedAt: now,
        }),
      );
      if (graph.status === "running") yield* advance;
      return yield* requireGraph(graph.id);
    });

  const edit: TaskGraphService["Service"]["edit"] = (graphId, edits) =>
    Effect.gen(function* () {
      const { graph, stopped, finished } = yield* locked(
        Effect.gen(function* () {
          const current = yield* requireGraph(graphId);
          if (current.status === "cancelled") {
            return yield* graphError("This task graph was cancelled.", graphId);
          }
          const result = applyTaskGraphEdits(current.nodes, edits, yield* nowIso);
          if (!result.ok) return yield* graphError(result.error, graphId);
          const stopped = current.nodes.filter((node) => {
            const next = result.nodes.find((candidate) => candidate.key === node.key);
            return isActiveTaskGraphNodeStatus(node.status) && next?.status === "cancelled";
          });
          // Retrying a node in a finished graph puts the graph back to work.
          const reopened = result.nodes.some((node) => node.status === "pending");
          const status =
            current.status === "draft" ? "draft" : reopened ? "running" : current.status;
          const graph = yield* writeGraph({ ...current, status, nodes: result.nodes });
          return {
            graph,
            stopped,
            finished: current.status === "running" && graph.status !== "running",
          };
        }),
      );
      yield* stopNodes(graph, stopped);
      if (finished) yield* reportFinished(graph);
      if (graph.status === "running") yield* advance;
      return yield* requireGraph(graphId);
    });

  const run: TaskGraphService["Service"]["run"] = (graphId) =>
    Effect.gen(function* () {
      yield* locked(
        Effect.gen(function* () {
          const graph = yield* requireGraph(graphId);
          if (graph.status !== "draft") {
            return yield* graphError("Only a draft task graph can be run.", graphId);
          }
          yield* writeGraph({ ...graph, status: "running" });
        }),
      );
      yield* advance;
      return yield* requireGraph(graphId);
    });

  const cancel: TaskGraphService["Service"]["cancel"] = (graphId) =>
    Effect.gen(function* () {
      const { graph, stopped } = yield* locked(
        Effect.gen(function* () {
          const current = yield* requireGraph(graphId);
          const completedAt = yield* nowIso;
          const nodes = current.nodes.map((node) =>
            isTerminalTaskGraphNodeStatus(node.status)
              ? node
              : { ...node, status: "cancelled" as const, error: "Cancelled.", completedAt },
          );
          const graph = yield* writeGraph({ ...current, status: "cancelled", nodes });
          return {
            graph,
            stopped: current.nodes.filter((node) => isActiveTaskGraphNodeStatus(node.status)),
          };
        }),
      );
      yield* stopNodes(graph, stopped);
      return graph;
    });

  const listForThread: TaskGraphService["Service"]["listForThread"] = (threadId) =>
    sql<TaskGraphRow>`
      SELECT graph_json FROM task_graphs WHERE thread_id = ${threadId} ORDER BY created_at
    `.pipe(
      Effect.mapError((cause) => graphError("Could not list task graphs.", undefined, cause)),
      Effect.flatMap(readGraphs),
    );

  const subscribeThread: TaskGraphService["Service"]["subscribeThread"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(listForThread(threadId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.mapEffect(() => listForThread(threadId)),
          ),
        ).pipe(Stream.map((graphs) => ({ graphs })));
      }),
    );

  // --- Startup ----------------------------------------------------------------

  // Rebuild the thread index, then catch up on node runs that ended while the
  // server was down. Launches are idempotent by command id, so a node that was
  // marked running but never launched is launched again.
  yield* Effect.gen(function* () {
    for (const graph of yield* resumableGraphs) indexGraph(graph);
    // A node continued in its thread while the server was down: follow it, and
    // record it if that run already finished after the node had failed.
    yield* Effect.forEach(
      [...endedByThread],
      ([threadId, { graphId, key }]) =>
        Effect.gen(function* () {
          const projection = yield* threads.getThreadProjection(threadId);
          const graph = yield* requireGraph(graphId);
          const endedAt = graph.nodes.find((node) => node.key === key)?.completedAt ?? null;
          const run = ThreadManagement.latestRun(projection);
          const ranAgain =
            ThreadManagement.latestActiveRun(projection) !== undefined ||
            (run?.completedAt != null &&
              endedAt !== null &&
              DateTime.toEpochMillis(run.completedAt) >
                DateTime.toEpochMillis(DateTime.makeUnsafe(endedAt)));
          if (!ranAgain) return;
          yield* resumeNode(graphId, key);
          yield* finishLocalNode(graphId, key, threadId);
        }).pipe(Effect.ignoreCause),
      { discard: true },
    );
    const graphs = yield* runningGraphs;
    yield* Effect.forEach(
      graphs.flatMap((graph) =>
        graph.nodes
          .filter(
            (node) =>
              node.status === "running" && node.assignedEnvironmentId === localEnvironmentId,
          )
          .map((node) => ({ graph, node })),
      ),
      ({ graph, node }) =>
        threads.getThreadProjection(node.threadId!).pipe(
          Effect.matchEffect({
            onFailure: () => launchNode(graph, node),
            onSuccess: () => finishLocalNode(graph.id, node.key, node.threadId!),
          }),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      graphs.flatMap((graph) =>
        graph.nodes
          .filter(
            (node) =>
              isActiveTaskGraphNodeStatus(node.status) &&
              node.assignedEnvironmentId !== null &&
              node.assignedEnvironmentId !== localEnvironmentId,
          )
          .map((node) => ({ graph, node })),
      ),
      ({ graph, node }) =>
        peers.track({
          environmentId: node.assignedEnvironmentId!,
          threadId: node.threadId!,
          delivery: peerDelivery(graph, node),
        }),
      { discard: true },
    );
    // A node mid-delivery when the server stopped redelivers; the git action is idempotent.
    yield* Effect.forEach(
      graphs.flatMap((graph) =>
        graph.nodes
          .filter(
            (node) =>
              node.status === "delivering" && node.assignedEnvironmentId === localEnvironmentId,
          )
          .map((node) => ({ graph, node })),
      ),
      ({ graph, node }) =>
        updateNode(graph.id, node.key, (current) => ({ ...current, status: "running" })).pipe(
          Effect.andThen(finishLocalNode(graph.id, node.key, node.threadId!)),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not recover task graphs", { cause: Cause.pretty(cause) }),
    ),
  );

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      if (event.type !== "run.updated") return Effect.void;
      if (!ThreadManagement.isTerminalRunStatus(event.payload.status)) {
        // Only a new run passes through an active status, so a repeated update of
        // the run that failed never resumes the node.
        const ended = endedByThread.get(event.threadId);
        return ended === undefined ? Effect.void : resumeNode(ended.graphId, ended.key);
      }
      const target = nodeByThread.get(event.threadId);
      return target === undefined
        ? Effect.void
        : finishLocalNode(target.graphId, target.key, event.threadId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Task graph event stream failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  yield* forkParked(Stream.runForEach(peers.completions, completeRemoteNode));

  // Retries nodes held back by load or the concurrency limit, and picks up peer capacity.
  yield* scheduler.register("task-graphs", advance);

  return TaskGraphService.of({
    create,
    get: requireGraph,
    listForThread,
    subscribeThread,
    edit,
    run,
    cancel,
    completeRemoteNode,
  });
});

export const layer = Layer.effect(TaskGraphService, make);
