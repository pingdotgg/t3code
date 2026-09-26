/**
 * `t3 peer <subcommand>` - federation between T3 Code servers: issue and
 * redeem peer codes, list peers, browse a peer's projects, and start or follow
 * runs on a peer.
 *
 * Federation management lives on the WebSocket RPC surface (the HTTP
 * federation group is the peer-to-peer protocol, not the operator API); see
 * runningServer.ts for discovery and credentials.
 */
import {
  EnvironmentId,
  FEDERATION_DEFAULT_SCOPES,
  FederationError,
  type FederationPeer,
  type FederationPeerCodeResult,
  type FederationProjectSummary,
  type FederationRemoteRun,
  type FederationRunEvent,
  FederationScope,
  isFederationRunStatusActive,
  type FederationSnapshot,
  ProjectId,
  TrimmedNonEmptyString,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { baseDirFlag, jsonFlag } from "./config.ts";
import {
  callRunningServer,
  codeTtlFlag,
  codeTtlInput,
  RunningServerRequestError,
  withRunningServerRpcClient,
  type WsRpcClient,
} from "./runningServer.ts";

const isFederationError = Schema.is(FederationError);

const runPeerCommand = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json?: boolean },
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withRunningServerRpcClient({
    baseDir: flags.baseDir,
    label: "t3 peer",
    quietLogs: flags.json === true,
    run,
  });

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

const formatPeer = (peer: FederationPeer): string =>
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

const formatPairedPeer = (peer: FederationPeer, options: { readonly json: boolean }): string =>
  options.json ? JSON.stringify(peer, null, 2) : `Paired with a new peer.\n\n${formatPeer(peer)}`;

const formatPeerList = (
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

const formatPeerCode = (
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

const formatRemoteProjects = (
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

const formatRunEvent = (event: FederationRunEvent): string =>
  `[${event.at}] ${event.type}${event.summary.length > 0 ? `: ${event.summary}` : ""}`;

const formatRemoteRun = (
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
    Stream.takeUntil((remoteRun) => !isFederationRunStatusActive(remoteRun.run.status)),
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

const peerIdArgument = Argument.String("peer-id").pipe(
  Argument.withDescription("Peer environment id, as listed by `t3 peer list`."),
  Argument.withSchema(EnvironmentId),
);

const scopeDescription = `Repeat for several; defaults to ${FEDERATION_DEFAULT_SCOPES.join(", ")}.`;

const peerCodeCommand = Command.make("code", {
  baseDir: baseDirFlag,
  scope: Flag.Literals("scope", FederationScope.literals).pipe(
    Flag.withDescription(`Scope offered to the server that redeems the code. ${scopeDescription}`),
    Flag.atLeast(0),
  ),
  ttl: codeTtlFlag,
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
            ...codeTtlInput(flags.ttl),
          }),
        );
        yield* Console.log(formatPeerCode(issued, { json: flags.json }));
      }),
    ),
  ),
);

const peerAddCommand = Command.make("add", {
  baseDir: baseDirFlag,
  code: Argument.String("code").pipe(
    Argument.withDescription("Peer code issued by `t3 peer code` on the other server."),
    Argument.withSchema(TrimmedNonEmptyString),
  ),
  grant: Flag.Literals("grant", FederationScope.literals).pipe(
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
  projectId: Argument.String("project-id").pipe(
    Argument.withDescription("Project on the peer, as listed by `t3 peer projects`."),
    Argument.withSchema(ProjectId),
  ),
  prompt: Argument.String("prompt").pipe(
    Argument.withDescription("Prompt for the run; several words are joined with spaces."),
    Argument.withSchema(TrimmedNonEmptyString),
    Argument.variadic({ min: 1 }),
  ),
  title: Flag.String("title").pipe(
    Flag.withDescription("Optional thread title on the peer."),
    Flag.optional,
  ),
  wait: Flag.Boolean("wait").pipe(
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
