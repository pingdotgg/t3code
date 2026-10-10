import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  repositoryGroupingKeyOf,
  TaskGraphError,
  WS_METHODS,
  WsRpcGroup,
  type HostResourcesSnapshot,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RuntimeMode,
  type TaskGraph,
  type TaskGraphNode,
  type TaskGraphPeer,
  type TaskGraphPeerListResult,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { NodeOutcome } from "./TaskGraphService.ts";

/** How a finished peer node's branch leaves the peer: always pushed, plus a PR at a branch end. */
export type PeerDelivery = "commit_push" | "commit_push_pr";

export interface PeerNodeStart {
  readonly environmentId: EnvironmentId;
  readonly graph: TaskGraph;
  readonly node: TaskGraphNode;
  readonly threadId: ThreadId;
  readonly baseRef: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly delivery: PeerDelivery;
}

export interface PeerCandidate {
  readonly environmentId: EnvironmentId;
  readonly resources: HostResourcesSnapshot | null;
  readonly receivedAt: number;
  readonly weight: number;
}

/**
 * Other machines this environment may run task graph nodes on. The graph
 * service asks for placement candidates, hands over nodes placed on a peer,
 * and hears back through `completions` when one ends.
 */
export class TaskGraphPeers extends Context.Service<
  TaskGraphPeers,
  {
    /** Whether any peer is paired; branches are then pushed so other machines can reach them. */
    readonly hasPeers: Effect.Effect<boolean>;
    /** Connected peers hosting the same repository, with fresh load, under `maxNodesPerPeer`. */
    readonly candidates: (input: {
      readonly projectId: ProjectId;
      readonly maxNodesPerPeer: number;
    }) => Effect.Effect<ReadonlyArray<PeerCandidate>>;
    readonly startNode: (input: PeerNodeStart) => Effect.Effect<void, TaskGraphError>;
    /** Watches a node started before a restart. */
    readonly track: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly delivery: PeerDelivery;
    }) => Effect.Effect<void>;
    readonly interruptNode: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly completions: Stream.Stream<{
      readonly threadId: ThreadId;
      readonly outcome: NodeOutcome;
    }>;
    readonly subscribe: Stream.Stream<TaskGraphPeerListResult, TaskGraphError>;
    readonly add: (input: {
      readonly pairingUrl: string;
      readonly label?: string | undefined;
    }) => Effect.Effect<TaskGraphPeerListResult, TaskGraphError>;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<TaskGraphPeerListResult, TaskGraphError>;
    readonly setWeight: (
      environmentId: EnvironmentId,
      weight: number,
    ) => Effect.Effect<TaskGraphPeerListResult, TaskGraphError>;
  }
>()("t3/taskGraph/TaskGraphPeers") {}

/** No peers: every node runs on this machine. Used by tests. */
export const layerNone = Layer.succeed(
  TaskGraphPeers,
  TaskGraphPeers.of({
    hasPeers: Effect.succeed(false),
    candidates: () => Effect.succeed([]),
    startNode: () => Effect.fail(new TaskGraphError({ message: "No peer machines are paired." })),
    track: () => Effect.void,
    interruptNode: () => Effect.void,
    completions: Stream.never,
    subscribe: Stream.make({ peers: [] }),
    add: () => Effect.fail(new TaskGraphError({ message: "Peers are unavailable." })),
    remove: () => Effect.succeed({ peers: [] }),
    setWeight: () => Effect.succeed({ peers: [] }),
  }),
);

/**
 * What this server asks a peer for. It can run, watch and stop threads and
 * push their branches; it cannot read files, open terminals, change settings
 * or manage access.
 */
export const PEER_SCOPES = ["orchestration:read", "orchestration:operate", "source-control:write"];

const DEFAULT_PEER_WEIGHT = 50;
const tokenSecretName = (environmentId: string) => `task-graph-peer-token:${environmentId}`;

const peerError = (message: string, cause?: unknown) =>
  new TaskGraphError({ message, ...(cause === undefined ? {} : { cause }) });

const TERMINAL_THREAD_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/** The outcome a finished peer thread implies, before delivery; null while it still runs. */
export function peerThreadOutcome(
  thread: Pick<OrchestrationV2ThreadShell, "status" | "activeRunId">,
): "succeeded" | "failed" | "cancelled" | null {
  if (thread.activeRunId !== null || !TERMINAL_THREAD_STATUSES.has(thread.status)) return null;
  if (thread.status === "completed") return "succeeded";
  return thread.status === "cancelled" || thread.status === "interrupted" ? "cancelled" : "failed";
}

const EnvironmentDescriptorJson = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
});
const decodeDescriptor = Schema.decodeUnknownEffect(EnvironmentDescriptorJson);
const decodeToken = Schema.decodeUnknownEffect(TokenResponse);

const toWsUrl = (httpBaseUrl: string) => {
  const url = new URL("/ws", httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  return url.toString();
};

const protocolLayer = (httpBaseUrl: string, token: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(toWsUrl(httpBaseUrl)).pipe(
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (url, protocols) =>
              new NodeSocket.NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
                headers: { authorization: `Bearer ${token}` },
              }) as unknown as globalThis.WebSocket,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeClient = RpcClient.make(WsRpcGroup);
type PeerClient = Effect.Success<typeof makeClient>;

interface PeerRow {
  readonly environment_id: string;
  readonly label: string;
  readonly http_base_url: string;
  readonly weight: number;
  readonly added_at: string;
}

interface PeerLive {
  status: TaskGraphPeer["status"];
  error: string | null;
  client: PeerClient | null;
  readonly projects: Map<string, OrchestrationProjectShell>;
  readonly threads: Map<string, OrchestrationV2ThreadShell>;
}

interface Tracked {
  readonly environmentId: EnvironmentId;
  readonly delivery: PeerDelivery;
  delivering: boolean;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const localEnvironmentId = yield* environment.getEnvironmentId;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  /** Reads a JSON body from a peer during pairing; any failure means the link is unusable. */
  const fetchJson = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) =>
        peerError(`Could not reach ${new URL(request.url).origin}.`, cause),
      ),
    );

  const live = new Map<string, PeerLive>();
  const tracked = new Map<ThreadId, Tracked>();
  const connections = yield* FiberMap.make<string>();
  const changes = yield* PubSub.sliding<void>(1);
  const completions = yield* Queue.unbounded<{ threadId: ThreadId; outcome: NodeOutcome }>();
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const readRows = sql<PeerRow>`
    SELECT environment_id, label, http_base_url, weight, added_at
    FROM task_graph_peers ORDER BY added_at
  `.pipe(Effect.mapError((cause) => peerError("Could not read peer machines.", cause)));

  const list = readRows.pipe(
    Effect.map((rows) => ({
      peers: rows.map((row): TaskGraphPeer => {
        const state = live.get(row.environment_id);
        return {
          environmentId: EnvironmentId.make(row.environment_id),
          label: row.label,
          httpBaseUrl: row.http_base_url,
          weight: row.weight,
          status: state?.status ?? "connecting",
          error: state?.error ?? null,
          addedAt: row.added_at,
        };
      }),
    })),
  );

  const setStatus = (
    environmentId: string,
    status: TaskGraphPeer["status"],
    error: string | null,
  ) =>
    Effect.suspend(() => {
      const state = live.get(environmentId);
      if (state === undefined || (state.status === status && state.error === error))
        return Effect.void;
      state.status = status;
      state.error = error;
      return notify;
    });

  // --- Remote node lifecycle ----------------------------------------------------

  /** Commits and pushes a finished peer thread's branch there, then reports the node. */
  const finishTracked = (environmentId: string, thread: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const entry = tracked.get(thread.id);
      const state = live.get(environmentId);
      const outcome = peerThreadOutcome(thread);
      if (entry === undefined || entry.delivering || outcome === null || state?.client == null)
        return;
      entry.delivering = true;
      if (outcome !== "succeeded") {
        tracked.delete(thread.id);
        yield* Queue.offer(completions, {
          threadId: thread.id,
          outcome: { type: outcome, error: `The node's run on ${environmentId} ${thread.status}.` },
        });
        return;
      }
      const summary =
        thread.latestVisibleMessage?.role === "assistant" ? thread.latestVisibleMessage.text : null;
      const delivered =
        thread.worktreePath === null
          ? Option.none<{ readonly url: string | null }>()
          : Option.some(
              yield* state.client[WS_METHODS.gitRunStackedAction]({
                actionId: `task-graph:${thread.id}`,
                cwd: thread.worktreePath,
                action: entry.delivery,
                threadId: thread.id,
                projectId: thread.projectId,
              }).pipe(
                Stream.runCollect,
                Effect.flatMap((events) => {
                  for (const event of events) {
                    if (event.kind === "action_failed")
                      return Effect.fail(peerError(event.message));
                    if (event.kind === "action_finished") {
                      return Effect.succeed({ url: event.result.pr.url ?? null });
                    }
                  }
                  return Effect.fail(peerError("The peer did not report how delivery went."));
                }),
              ),
            );
      tracked.delete(thread.id);
      yield* Queue.offer(completions, {
        threadId: thread.id,
        outcome: {
          type: "succeeded",
          summary,
          branch: thread.branch,
          ...(entry.delivery === "commit_push_pr" && Option.isSome(delivered)
            ? { pullRequestUrl: delivered.value.url }
            : {}),
        },
      });
    }).pipe(
      Effect.catchCause((cause) => {
        tracked.delete(thread.id);
        return Queue.offer(completions, {
          threadId: thread.id,
          outcome: {
            type: "failed",
            error: `Could not push the node's branch from the peer: ${Cause.pretty(cause)}`,
          },
        }).pipe(Effect.asVoid);
      }),
    );

  const handleShellItem = (
    environmentId: string,
    state: PeerLive,
    item: OrchestrationV2ShellStreamItem,
  ) =>
    Effect.gen(function* () {
      const changed: OrchestrationV2ThreadShell[] = [];
      switch (item.kind) {
        case "snapshot":
          state.projects.clear();
          state.threads.clear();
          for (const project of item.snapshot.projects) state.projects.set(project.id, project);
          for (const thread of item.snapshot.threads) {
            state.threads.set(thread.id, thread);
            changed.push(thread);
          }
          break;
        case "project.updated":
          state.projects.set(item.project.id, item.project);
          break;
        case "project.removed":
          state.projects.delete(item.projectId);
          break;
        case "thread.updated":
          state.threads.set(item.thread.id, item.thread);
          changed.push(item.thread);
          break;
        case "thread.removed": {
          state.threads.delete(item.threadId);
          const entry = tracked.get(item.threadId);
          if (entry !== undefined && entry.environmentId === environmentId) {
            tracked.delete(item.threadId);
            yield* Queue.offer(completions, {
              threadId: item.threadId,
              outcome: { type: "failed", error: "The node's thread was deleted on the peer." },
            });
          }
          break;
        }
        default:
          break;
      }
      for (const thread of changed) {
        if (tracked.get(thread.id)?.environmentId === environmentId) {
          // Delivery waits on the peer's git work; do not hold up the shell stream.
          yield* finishTracked(environmentId, thread).pipe(Effect.forkDetach);
        }
      }
    });

  /** One connection to a peer, until it drops. */
  const connectOnce = (row: PeerRow, token: string, state: PeerLive) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const config = yield* client[WS_METHODS.serverGetConfig]({});
      if (config.environment.environmentId !== row.environment_id) {
        return yield* peerError(
          `The machine at ${row.http_base_url} is now a different environment. Pair it again.`,
        );
      }
      state.client = client;
      yield* setStatus(row.environment_id, "connected", null);
      yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
        Stream.runForEach((item) => handleShellItem(row.environment_id, state, item)),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(protocolLayer(row.http_base_url, token)),
      Effect.ensuring(Effect.sync(() => (state.client = null))),
    );

  const connect = (row: PeerRow) =>
    Effect.gen(function* () {
      const token = yield* secrets.get(tokenSecretName(row.environment_id));
      if (Option.isNone(token)) {
        return yield* setStatus(
          row.environment_id,
          "unauthorized",
          "The peer's credential is missing. Pair it again.",
        );
      }
      const state = live.get(row.environment_id)!;
      const tokenText = new TextDecoder().decode(token.value);
      yield* connectOnce(row, tokenText, state).pipe(
        Effect.catchCause((cause) => {
          const message = Cause.pretty(cause);
          return setStatus(
            row.environment_id,
            /\b401\b|unauthori[sz]ed/i.test(message) ? "unauthorized" : "unreachable",
            message.split("\n")[0] ?? message,
          );
        }),
        Effect.repeat(Schedule.spaced("15 seconds")),
      );
    }).pipe(Effect.ignoreCause);

  const startConnection = (row: PeerRow) =>
    Effect.gen(function* () {
      live.set(row.environment_id, {
        status: "connecting",
        error: null,
        client: null,
        projects: new Map(),
        threads: new Map(),
      });
      yield* FiberMap.run(connections, row.environment_id, connect(row));
    });

  yield* readRows.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, startConnection, { discard: true })),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not start task graph peer connections", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  // --- Service ------------------------------------------------------------------

  const repositoryKeyOf = (projectId: ProjectId) =>
    projects.getShell(projectId).pipe(
      Effect.map((shell) =>
        Option.flatMap(shell, (project) =>
          Option.fromNullishOr(project.repositoryIdentity).pipe(
            Option.map(repositoryGroupingKeyOf),
          ),
        ),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const peerProjectFor = (state: PeerLive, key: string) =>
    [...state.projects.values()].find(
      (project) =>
        project.repositoryIdentity != null &&
        repositoryGroupingKeyOf(project.repositoryIdentity) === key,
    );

  const candidates: TaskGraphPeers["Service"]["candidates"] = ({ projectId, maxNodesPerPeer }) =>
    Effect.gen(function* () {
      const key = yield* repositoryKeyOf(projectId);
      if (Option.isNone(key)) return [];
      const rows = yield* readRows.pipe(Effect.orElseSucceed(() => []));
      const usable = rows.flatMap((row) => {
        const state = live.get(row.environment_id);
        const running = [...tracked.values()].filter(
          (entry) => entry.environmentId === row.environment_id,
        ).length;
        return state?.client != null &&
          row.weight > 0 &&
          running < maxNodesPerPeer &&
          peerProjectFor(state, key.value) !== undefined
          ? [{ row, client: state.client }]
          : [];
      });
      return yield* Effect.forEach(
        usable,
        ({ row, client }) =>
          client[WS_METHODS.serverGetHostResources]({}).pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => null),
            Effect.flatMap((resources) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((receivedAt) => ({
                  environmentId: EnvironmentId.make(row.environment_id),
                  resources,
                  receivedAt,
                  weight: row.weight,
                })),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

  const startNode: TaskGraphPeers["Service"]["startNode"] = (input) =>
    Effect.gen(function* () {
      const state = live.get(input.environmentId);
      const client = state?.client;
      if (state === undefined || client == null) {
        return yield* peerError(`The peer ${input.environmentId} is not connected.`);
      }
      const key = yield* repositoryKeyOf(input.graph.projectId);
      const project = Option.isNone(key) ? undefined : peerProjectFor(state, key.value);
      if (project === undefined) {
        return yield* peerError("The peer has no project for this repository.");
      }
      tracked.set(input.threadId, {
        environmentId: input.environmentId,
        delivery: input.delivery,
        delivering: false,
      });
      yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make(`task-graph-launch:${input.threadId}`),
        creationSource: "server",
        threadId: input.threadId,
        projectId: project.id,
        title: input.node.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        // Dependency branches were pushed by whichever machine ran them.
        workspaceStrategy: { type: "worktree", baseRef: input.baseRef, startFromOrigin: true },
        initialMessage: { text: input.prompt, attachments: [] },
      }).pipe(
        Effect.tapError(() => Effect.sync(() => tracked.delete(input.threadId))),
        Effect.mapError((cause) => peerError("The peer could not start the node.", cause)),
      );
    });

  const track: TaskGraphPeers["Service"]["track"] = ({ environmentId, threadId, delivery }) =>
    Effect.gen(function* () {
      tracked.set(threadId, { environmentId, delivery, delivering: false });
      const thread = live.get(environmentId)?.threads.get(threadId);
      if (thread !== undefined) yield* finishTracked(environmentId, thread).pipe(Effect.forkDetach);
    });

  const interruptNode: TaskGraphPeers["Service"]["interruptNode"] = ({ environmentId, threadId }) =>
    Effect.gen(function* () {
      tracked.delete(threadId);
      const state = live.get(environmentId);
      const runId = state?.threads.get(threadId)?.activeRunId;
      if (state?.client == null || runId == null) return;
      yield* state.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "run.interrupt",
        commandId: CommandId.make(`task-graph-stop:${threadId}`),
        threadId,
        runId,
        reason: "The task graph branch was cancelled.",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not stop a peer task graph node", {
          environmentId,
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const add: TaskGraphPeers["Service"]["add"] = (input) =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => resolveRemotePairingTarget({ pairingUrl: input.pairingUrl }),
        catch: (cause) => peerError("That is not a pairing link.", cause),
      });
      const descriptor = yield* fetchJson(
        HttpClientRequest.get(
          new URL("/.well-known/t3/environment", target.httpBaseUrl).toString(),
        ),
      ).pipe(
        Effect.flatMap((body) =>
          decodeDescriptor(body).pipe(
            Effect.mapError((cause) =>
              peerError("The link does not point at a T3 Code server.", cause),
            ),
          ),
        ),
      );
      if (descriptor.environmentId === localEnvironmentId) {
        return yield* peerError("That link points at this machine.");
      }
      const label = input.label ?? (descriptor.label.trim() || target.httpBaseUrl);
      const token = yield* fetchJson(
        HttpClientRequest.post(new URL("/oauth/token", target.httpBaseUrl).toString()).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: target.credential,
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            scope: PEER_SCOPES.join(" "),
            client_label: "T3 Code task graphs",
            client_device_type: "bot",
          }),
        ),
      ).pipe(
        Effect.flatMap((body) =>
          decodeToken(body).pipe(
            Effect.mapError((cause) => peerError("The peer refused the link.", cause)),
          ),
        ),
      );
      if (token.token_type.toLowerCase() !== "bearer") {
        return yield* peerError("The peer issued a credential this server cannot use.");
      }
      yield* secrets
        .set(
          tokenSecretName(descriptor.environmentId),
          new TextEncoder().encode(token.access_token),
        )
        .pipe(
          Effect.mapError((cause) => peerError("Could not store the peer's credential.", cause)),
        );
      const addedAt = DateTime.formatIso(yield* DateTime.now);
      const row: PeerRow = {
        environment_id: descriptor.environmentId,
        label,
        http_base_url: target.httpBaseUrl,
        weight: DEFAULT_PEER_WEIGHT,
        added_at: addedAt,
      };
      yield* sql`
        INSERT INTO task_graph_peers (environment_id, label, http_base_url, weight, added_at)
        VALUES (${row.environment_id}, ${row.label}, ${row.http_base_url}, ${row.weight}, ${row.added_at})
        ON CONFLICT (environment_id) DO UPDATE SET
          label = excluded.label,
          http_base_url = excluded.http_base_url
      `.pipe(Effect.mapError((cause) => peerError("Could not save the peer.", cause)));
      yield* startConnection(row);
      yield* notify;
      return yield* list;
    });

  const remove: TaskGraphPeers["Service"]["remove"] = (environmentId) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(connections, environmentId);
      live.delete(environmentId);
      yield* sql`DELETE FROM task_graph_peers WHERE environment_id = ${environmentId}`.pipe(
        Effect.mapError((cause) => peerError("Could not remove the peer.", cause)),
      );
      // Forgetting the token is what unpairs on this side; the peer lists the
      // session under its connected clients until someone revokes it there.
      yield* secrets.remove(tokenSecretName(environmentId)).pipe(Effect.ignore);
      for (const [threadId, entry] of tracked) {
        if (entry.environmentId !== environmentId) continue;
        tracked.delete(threadId);
        yield* Queue.offer(completions, {
          threadId,
          outcome: { type: "failed", error: "The peer running this node was removed." },
        });
      }
      yield* notify;
      return yield* list;
    });

  const setWeight: TaskGraphPeers["Service"]["setWeight"] = (environmentId, weight) =>
    sql`UPDATE task_graph_peers SET weight = ${weight} WHERE environment_id = ${environmentId}`.pipe(
      Effect.mapError((cause) => peerError("Could not update the peer.", cause)),
      Effect.andThen(notify),
      Effect.andThen(list),
    );

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  return TaskGraphPeers.of({
    hasPeers: readRows.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.orElseSucceed(() => false),
    ),
    candidates,
    startNode,
    track,
    interruptNode,
    completions: Stream.fromQueue(completions),
    subscribe,
    add,
    remove,
    setWeight,
  });
});

export const layer = Layer.effect(TaskGraphPeers, make).pipe(Layer.provide(FetchHttpClient.layer));
