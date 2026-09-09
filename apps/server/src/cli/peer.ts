/**
 * `t3 peer <subcommand>` - federation between T3 Code servers: issue and
 * redeem peer codes, list peers, browse a peer's projects, and start or follow
 * runs on a peer.
 *
 * Federation management lives on the WebSocket RPC surface (the HTTP
 * federation group is the peer-to-peer protocol, not the operator API), so
 * this command opens an RPC connection to the running server with the same
 * short-lived administrative session `t3 remote` uses, carried as a bearer
 * header on the upgrade request.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  EnvironmentId,
  FEDERATION_DEFAULT_SCOPES,
  FederationError,
  type FederationPeer,
  type FederationPeerCodeResult,
  type FederationProjectSummary,
  type FederationRemoteRun,
  type FederationRunEvent,
  type FederationRunStatus,
  FederationScope,
  type FederationSnapshot,
  ProjectId,
  TrimmedNonEmptyString,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { baseDirFlag, DurationFromString, jsonFlag } from "./config.ts";
import {
  RunningServerRequestError,
  type RunningServerSession,
  withRunningServerSession,
  callRunningServer,
} from "./remote.ts";

const RPC_OPEN_TIMEOUT = Duration.seconds(10);

const isFederationError = Schema.is(FederationError);

const TERMINAL_RUN_STATUSES: ReadonlySet<FederationRunStatus> = new Set([
  "completed",
  "interrupted",
  "error",
]);

const isTerminalRunStatus = (status: FederationRunStatus): boolean =>
  TERMINAL_RUN_STATUSES.has(status);

/** The server's `/ws` route on the origin it recorded; the dev proxy is not involved on loopback. */
export const runningServerWsUrl = (origin: string): string => {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

// Node's `ws` client rather than the global WebSocket: the administrative
// bearer token has to ride on the upgrade request, and only `ws` takes headers.
const bearerWebSocketConstructorLayer = (token: string) =>
  Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );

const rpcProtocolLayer = (session: RunningServerSession) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(runningServerWsUrl(session.origin), {
        openTimeout: RPC_OPEN_TIMEOUT,
      }).pipe(Layer.provide(bearerWebSocketConstructorLayer(session.token))),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = Effect.Success<typeof makeRpcClient>;

const runPeerCommand = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json?: boolean },
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withRunningServerSession({
    baseDir: flags.baseDir,
    label: "t3 peer",
    quietLogs: flags.json === true,
    run: (session) =>
      Effect.scoped(
        makeRpcClient.pipe(Effect.flatMap(run), Effect.provide(rpcProtocolLayer(session))),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));

// Typed federation failures are worded for the user by the server; anything
// else (authorization, transport, no answer) gets the generic wrapper.
const call = <A, E>(operation: string, request: Effect.Effect<A, E>) =>
  callRunningServer(operation, request, isFederationError);

const scopeList = (scopes: ReadonlyArray<FederationScope>): string =>
  scopes.length === 0 ? "none" : scopes.join(" ");

const uniqueScopesOrDefault = (
  scopes: ReadonlyArray<FederationScope>,
): ReadonlyArray<FederationScope> =>
  scopes.length === 0 ? FEDERATION_DEFAULT_SCOPES : Array.from(new Set(scopes));

export const formatPeer = (peer: FederationPeer): string =>
  [
    `${peer.label} (${peer.peerId}) ${peer.status}`,
    `  fingerprint: ${peer.publicKeyFingerprint}`,
    `  granted (they may do here): ${scopeList(peer.grantedScopes)}`,
    `  allowed (we may do there): ${scopeList(peer.allowedScopes)}`,
    `  transport: ${
      peer.transport === null
        ? "none"
        : `tailcat ${peer.transport.tailcat.address}:${String(peer.transport.tailcat.port)}`
    }`,
    `  server: ${peer.remoteServerVersion ?? "unknown"}`,
    `  last seen: ${peer.lastSeenAt ?? "never"}`,
    ...(peer.lastError === null ? [] : [`  last error: ${peer.lastError}`]),
  ].join("\n");

export const formatPairedPeer = (
  peer: FederationPeer,
  options: { readonly json: boolean },
): string =>
  options.json ? JSON.stringify(peer, null, 2) : `Paired with a new peer.\n\n${formatPeer(peer)}`;

export const formatPeerList = (
  snapshot: FederationSnapshot,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(snapshot.peers, null, 2);
  }
  const header = `This environment: ${snapshot.environmentId} (fingerprint ${snapshot.publicKeyFingerprint})`;
  if (snapshot.peers.length === 0) {
    return `${header}\n\nNo peers. Create a code with \`t3 peer code\` or redeem one with \`t3 peer add <code>\`.`;
  }
  return [header, "", snapshot.peers.map(formatPeer).join("\n\n")].join("\n");
};

export const formatPeerCode = (
  issued: FederationPeerCodeResult,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(issued, null, 2);
  }
  return [
    `Peer code (expires ${issued.expiresAt}, single use):`,
    issued.code,
    "",
    `Offered scopes: ${scopeList(issued.payload.scopes)}`,
    "On the other server, run `t3 peer add <code>` to pair it with this one.",
    "Warning: this code embeds a one-time pairing credential. Share it only with the server you are pairing.",
  ].join("\n");
};

export const formatRemoteProjects = (
  projects: ReadonlyArray<FederationProjectSummary>,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(projects, null, 2);
  }
  if (projects.length === 0) {
    return "The peer has no projects.";
  }
  return projects
    .map((project) =>
      [`${project.title} (${project.id})`, `  path: ${project.workspaceRoot}`].join("\n"),
    )
    .join("\n\n");
};

export const formatRunEvent = (event: FederationRunEvent): string =>
  `[${event.at}] ${event.type}${event.summary.length > 0 ? `: ${event.summary}` : ""}`;

export const formatRemoteRun = (
  remoteRun: FederationRemoteRun,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(remoteRun, null, 2);
  }
  return [
    `Run ${remoteRun.run.threadId} on ${remoteRun.peerLabel}: ${remoteRun.run.status}`,
    `  title: ${remoteRun.run.title}`,
    `  project: ${remoteRun.run.projectId}`,
    `  model: ${remoteRun.run.modelSelection.instanceId}/${remoteRun.run.modelSelection.model}`,
    ...(remoteRun.run.assistantPreview === null
      ? []
      : [`  assistant: ${remoteRun.run.assistantPreview}`]),
    ...(remoteRun.syncError === null ? [] : [`  sync error: ${remoteRun.syncError}`]),
  ].join("\n");
};

/**
 * Follow one remote run through the remote-runs subscription, printing each
 * event once as it lands, until the run reaches a terminal status. Resolves
 * with the last snapshot of the run, or none if the server stopped tracking it.
 */
const followRemoteRun = Effect.fn("peer.followRemoteRun")(function* (
  client: WsRpcClient,
  started: FederationRemoteRun,
  options: { readonly json: boolean },
) {
  const printedThrough = yield* Ref.make(-1);
  const latest = yield* Ref.make(Option.none<FederationRemoteRun>());
  yield* client[WS_METHODS.federationSubscribeRemoteRuns]({}).pipe(
    Stream.map((snapshot) =>
      snapshot.runs.find(
        (candidate) =>
          candidate.peerId === started.peerId && candidate.run.threadId === started.run.threadId,
      ),
    ),
    Stream.filter(Predicate.isNotUndefined),
    Stream.takeUntil((remoteRun) => isTerminalRunStatus(remoteRun.run.status)),
    Stream.runForEach((remoteRun) =>
      Effect.gen(function* () {
        yield* Ref.set(latest, Option.some(remoteRun));
        if (options.json) {
          return;
        }
        const seen = yield* Ref.get(printedThrough);
        const fresh = remoteRun.events.filter((event) => event.sequence > seen);
        const last = fresh.at(-1);
        if (last === undefined) {
          return;
        }
        yield* Ref.set(printedThrough, last.sequence);
        yield* Console.log(fresh.map(formatRunEvent).join("\n"));
      }),
    ),
    Effect.mapError((cause) =>
      isFederationError(cause)
        ? cause
        : new RunningServerRequestError({ operation: "federation.subscribeRemoteRuns", cause }),
    ),
  );
  return yield* Ref.get(latest);
});

const peerIdArgument = Argument.string("peer-id").pipe(
  Argument.withDescription("Peer environment id, as listed by `t3 peer list`."),
  Argument.withSchema(EnvironmentId),
);

const scopeDescription = `Repeat for several; defaults to ${FEDERATION_DEFAULT_SCOPES.join(", ")}.`;

const peerCodeCommand = Command.make("code", {
  baseDir: baseDirFlag,
  scope: Flag.choice("scope", FederationScope.literals).pipe(
    Flag.withDescription(`Scope offered to the server that redeems the code. ${scopeDescription}`),
    Flag.atLeast(0),
  ),
  ttl: Flag.string("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "How long the code stays redeemable, for example `5m` or `1h`. Defaults to 5 minutes.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a one-time peer code another T3 Code server can redeem."),
  Command.withHandler((flags) =>
    runPeerCommand(flags, (client) =>
      Effect.gen(function* () {
        const issued = yield* call(
          "federation.createPeerCode",
          client[WS_METHODS.federationCreatePeerCode]({
            scopes: uniqueScopesOrDefault(flags.scope),
            ...(Option.isSome(flags.ttl)
              ? { ttlSeconds: Math.max(1, Math.round(Duration.toSeconds(flags.ttl.value))) }
              : {}),
          }),
        );
        yield* Console.log(formatPeerCode(issued, { json: flags.json }));
      }),
    ),
  ),
);

const peerAddCommand = Command.make("add", {
  baseDir: baseDirFlag,
  code: Argument.string("code").pipe(
    Argument.withDescription("Peer code issued by `t3 peer code` on the other server."),
    Argument.withSchema(TrimmedNonEmptyString),
  ),
  grant: Flag.choice("grant", FederationScope.literals).pipe(
    Flag.withDescription(`Scope this server grants the new peer. ${scopeDescription}`),
    Flag.atLeast(0),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Redeem a peer code and pair this server with the one that issued it."),
  Command.withHandler((flags) =>
    runPeerCommand(flags, (client) =>
      Effect.gen(function* () {
        const peer = yield* call(
          "federation.addPeer",
          client[WS_METHODS.federationAddPeer]({
            code: flags.code,
            grantedScopes: uniqueScopesOrDefault(flags.grant),
          }),
        );
        yield* Console.log(formatPairedPeer(peer, { json: flags.json }));
      }),
    ),
  ),
);

const peerListCommand = Command.make("list", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the servers this environment is paired with."),
  Command.withHandler((flags) =>
    runPeerCommand(flags, (client) =>
      Effect.gen(function* () {
        const snapshot = yield* call(
          "federation.subscribePeers",
          Stream.runHead(client[WS_METHODS.federationSubscribePeers]({})),
        );
        if (Option.isNone(snapshot)) {
          return yield* new RunningServerRequestError({
            operation: "federation.subscribePeers",
            cause: "The server closed the peer subscription before sending a snapshot.",
          });
        }
        yield* Console.log(formatPeerList(snapshot.value, { json: flags.json }));
      }),
    ),
  ),
);

const peerRemoveCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  peerId: peerIdArgument,
}).pipe(
  Command.withDescription(
    "Remove a peer. Its sessions here end and runs it delegated stop syncing.",
  ),
  Command.withHandler((flags) =>
    runPeerCommand(flags, (client) =>
      Effect.gen(function* () {
        yield* call(
          "federation.removePeer",
          client[WS_METHODS.federationRemovePeer]({ peerId: flags.peerId }),
        );
        yield* Console.log(`Removed peer ${flags.peerId}.`);
      }),
    ),
  ),
);

const peerProjectsCommand = Command.make("projects", {
  baseDir: baseDirFlag,
  peerId: peerIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the projects a peer exposes."),
  Command.withHandler((flags) =>
    runPeerCommand(flags, (client) =>
      Effect.gen(function* () {
        const response = yield* call(
          "federation.listRemoteProjects",
          client[WS_METHODS.federationListRemoteProjects]({ peerId: flags.peerId }),
        );
        yield* Console.log(formatRemoteProjects(response.projects, { json: flags.json }));
      }),
    ),
  ),
);

const peerRunCommand = Command.make("run", {
  baseDir: baseDirFlag,
  peerId: peerIdArgument,
  projectId: Argument.string("project-id").pipe(
    Argument.withDescription("Project on the peer, as listed by `t3 peer projects`."),
    Argument.withSchema(ProjectId),
  ),
  prompt: Argument.string("prompt").pipe(
    Argument.withDescription("Prompt for the run; several words are joined with spaces."),
    Argument.withSchema(TrimmedNonEmptyString),
    Argument.variadic({ min: 1 }),
  ),
  title: Flag.string("title").pipe(
    Flag.withDescription("Optional thread title on the peer."),
    Flag.optional,
  ),
  wait: Flag.boolean("wait").pipe(
    Flag.withDescription("Follow the run and print its events until it finishes."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a run on a peer's project."),
  Command.withHandler((flags) =>
    runPeerCommand(flags, (client) =>
      Effect.gen(function* () {
        const started = yield* call(
          "federation.startRemoteRun",
          client[WS_METHODS.federationStartRemoteRun]({
            peerId: flags.peerId,
            projectId: flags.projectId,
            prompt: flags.prompt.join(" "),
            ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
          }),
        );
        if (!flags.wait) {
          yield* Console.log(formatRemoteRun(started, { json: flags.json }));
          return;
        }

        if (!flags.json) {
          yield* Console.log(
            `Started run ${started.run.threadId} on ${started.peerLabel} (${started.run.status}). Following until it finishes; Ctrl-C stops following, not the run.`,
          );
        }
        const final = yield* followRemoteRun(client, started, { json: flags.json });
        if (Option.isNone(final)) {
          return yield* new FederationError({
            code: "run-not-found",
            message: `The server stopped tracking run ${started.run.threadId} before it finished.`,
          });
        }
        yield* Console.log(formatRemoteRun(final.value, { json: flags.json }));
      }),
    ),
  ),
);

export const peerCommand = Command.make("peer").pipe(
  Command.withDescription("Pair with other T3 Code servers and delegate runs to them."),
  Command.withSubcommands([
    peerCodeCommand,
    peerAddCommand,
    peerListCommand,
    peerRemoveCommand,
    peerProjectsCommand,
    peerRunCommand,
  ]),
);
