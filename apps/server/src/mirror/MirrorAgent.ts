/**
 * MirrorAgent - origin-side runtime of project mirroring.
 *
 * Runs on the environment that owns the real working copy (the laptop). For
 * every persisted mirror link it keeps one outbound connection to the host:
 * WS-ticket handshake with the mirror:sync bearer, a long-lived
 * `mirror.connect` stream for directives, `mirror.respond` for answers, and
 * signed HTTP URLs for the bundle bytes. Reachability is strictly
 * origin -> host; the host never dials out.
 *
 * @module MirrorAgent
 */
import {
  MirrorLinkNotFoundError,
  MirrorNotARepositoryError,
  MirrorSyncFailedError,
  WS_METHODS,
  WsRpcGroup,
  type MirrorAgentResponse,
  type MirrorAttachInput,
  type MirrorDetachInput,
  type MirrorDirective,
  type MirrorStreamEvent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { GitSync } from "./GitSync.ts";
import { readMirrorIncludePaths } from "./mirrorInclude.ts";

const RECONNECT_SCHEDULE = Schedule.spaced(Duration.seconds(15));
const TICKET_TIMEOUT = Duration.seconds(30);
const TRANSFER_TIMEOUT = Duration.minutes(30);

const linkTokenSecretName = (projectId: string) => `mirror-link-token-${projectId}`;

const WebSocketTicketResponse = Schema.Struct({ ticket: Schema.String });
const decodeTicket = Schema.decodeUnknownEffect(WebSocketTicketResponse);

export interface MirrorLink {
  readonly projectId: ProjectId;
  readonly hostUrl: string;
  readonly localRoot: string;
  readonly createdAt: string;
}

interface MirrorLinkRow {
  readonly projectId: string;
  readonly hostUrl: string;
  readonly localRoot: string;
  readonly createdAt: string;
}

export class MirrorAgentManager extends Context.Service<
  MirrorAgentManager,
  {
    readonly attach: (
      input: MirrorAttachInput,
    ) => Effect.Effect<void, MirrorNotARepositoryError | MirrorSyncFailedError>;
    readonly detach: (input: MirrorDetachInput) => Effect.Effect<void, MirrorLinkNotFoundError>;
    /** Start agents for every persisted link; called once at server startup. */
    readonly startPersisted: Effect.Effect<void>;
    readonly listLinks: Effect.Effect<ReadonlyArray<MirrorLink>>;
  }
>()("t3/mirror/MirrorAgent/MirrorAgentManager") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const gitSync = yield* GitSync;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const managerScope = yield* Scope.make("sequential");
  const includePathsFor = readMirrorIncludePaths({ fileSystem, path });

  const agents = yield* SynchronizedRef.make<ReadonlyMap<string, Fiber.Fiber<unknown, unknown>>>(
    new Map(),
  );
  const stagingDir = path.join(serverConfig.mirrorsDir, ".agent-staging");
  yield* fileSystem.makeDirectory(stagingDir, { recursive: true }).pipe(Effect.ignore);

  // --- link persistence ------------------------------------------------------

  const loadLinks = sql<MirrorLinkRow>`
    SELECT
      project_id AS "projectId",
      host_url AS "hostUrl",
      local_root AS "localRoot",
      created_at AS "createdAt"
    FROM mirror_links
  `.pipe(
    Effect.map((rows) => rows.map((row) => ({ ...row, projectId: row.projectId as ProjectId }))),
    Effect.orDie,
  );

  const saveLink = (link: MirrorLink) =>
    sql`
      INSERT INTO mirror_links (project_id, host_url, local_root, created_at)
      VALUES (${link.projectId}, ${link.hostUrl}, ${link.localRoot}, ${link.createdAt})
      ON CONFLICT (project_id)
      DO UPDATE SET
        host_url = excluded.host_url,
        local_root = excluded.local_root,
        created_at = excluded.created_at
    `.pipe(Effect.orDie);

  const deleteLink = (projectId: string) =>
    sql`DELETE FROM mirror_links WHERE project_id = ${projectId}`.pipe(Effect.orDie);

  // --- host HTTP plumbing ----------------------------------------------------

  const hostHttpBase = (hostUrl: string) => hostUrl.replace(/\/+$/, "");

  const hostWsUrl = (hostUrl: string, ticket: string) => {
    const url = new URL(hostHttpBase(hostUrl));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    return url.toString();
  };

  const issueTicket = Effect.fn("MirrorAgent.issueTicket")(function* (
    link: MirrorLink,
    token: string,
  ) {
    const response = yield* httpClient
      .post(`${hostHttpBase(link.hostUrl)}/api/auth/websocket-ticket`, {
        headers: { authorization: `Bearer ${token}` },
      })
      .pipe(
        Effect.timeout(TICKET_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new MirrorSyncFailedError({
              projectId: link.projectId,
              detail: `Websocket ticket request failed: ${String(cause)}`,
            }),
        ),
      );
    if (response.status !== 200) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        detail: `Host rejected the websocket ticket request with status ${response.status}.`,
      });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        () =>
          new MirrorSyncFailedError({
            projectId: link.projectId,
            detail: "Host returned an unreadable websocket ticket response.",
          }),
      ),
    );
    const decoded = yield* decodeTicket(body).pipe(
      Effect.mapError(
        () =>
          new MirrorSyncFailedError({
            projectId: link.projectId,
            detail: "Host returned a malformed websocket ticket response.",
          }),
      ),
    );
    return decoded.ticket;
  });

  const uploadBundle = Effect.fn("MirrorAgent.uploadBundle")(function* (
    link: MirrorLink,
    relativeUrl: string,
    bundlePath: string,
  ) {
    const stat = yield* fileSystem
      .stat(bundlePath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new MirrorSyncFailedError({ projectId: link.projectId, detail: cause.message }),
        ),
      );
    const request = HttpClientRequest.put(`${hostHttpBase(link.hostUrl)}${relativeUrl}`).pipe(
      HttpClientRequest.setBody(
        HttpBody.stream(
          fileSystem.stream(bundlePath),
          "application/octet-stream",
          Number(stat.size),
        ),
      ),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(TRANSFER_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new MirrorSyncFailedError({
            projectId: link.projectId,
            detail: `Bundle upload failed: ${String(cause)}`,
          }),
      ),
    );
    if (response.status !== 200 && response.status !== 204) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        detail: `Bundle upload failed with status ${response.status}.`,
      });
    }
  });

  const downloadBundle = Effect.fn("MirrorAgent.downloadBundle")(function* (
    link: MirrorLink,
    relativeUrl: string,
    bundlePath: string,
  ) {
    const response = yield* httpClient.get(`${hostHttpBase(link.hostUrl)}${relativeUrl}`).pipe(
      Effect.timeout(TRANSFER_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new MirrorSyncFailedError({
            projectId: link.projectId,
            detail: `Bundle download failed: ${String(cause)}`,
          }),
      ),
    );
    if (response.status !== 200) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        detail: `Bundle download failed with status ${response.status}.`,
      });
    }
    yield* Stream.run(response.stream, fileSystem.sink(bundlePath)).pipe(
      Effect.mapError(
        (cause) => new MirrorSyncFailedError({ projectId: link.projectId, detail: String(cause) }),
      ),
    );
  });

  // --- directive handlers ----------------------------------------------------

  const agentStagingPath = (syncId: string) => path.join(stagingDir, `${syncId}.bundle`);

  const handleSeedRequested = Effect.fn("MirrorAgent.handleSeedRequested")(function* (
    link: MirrorLink,
    directive: Extract<MirrorDirective, { type: "seed-requested" }>,
  ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
    const gitFailed = (cause: { readonly message: string }) =>
      new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId: directive.syncId,
        detail: cause.message,
      });
    const includePaths = yield* includePathsFor(link.localRoot);
    const snapshot = yield* gitSync
      .createSnapshot({ root: link.localRoot, syncId: directive.syncId, includePaths })
      .pipe(Effect.mapError(gitFailed));
    const bundlePath = agentStagingPath(directive.syncId);
    yield* gitSync
      .createSeedBundle({
        root: link.localRoot,
        bundlePath,
        snapshotRef: `refs/t3/mirror/snapshots/${directive.syncId}`,
      })
      .pipe(Effect.mapError(gitFailed));
    yield* uploadBundle(link, directive.uploadUrl, bundlePath).pipe(
      Effect.ensuring(fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore)),
    );
    const headRef = yield* gitSync.symbolicHead(link.localRoot).pipe(Effect.mapError(gitFailed));
    const remotes = yield* gitSync.listRemotes(link.localRoot).pipe(Effect.mapError(gitFailed));
    yield* gitSync
      .pruneSnapshotRefs({ root: link.localRoot, keepOids: [snapshot.snapshotOid] })
      .pipe(Effect.ignore);
    return {
      type: "seed-uploaded",
      syncId: directive.syncId,
      headRef,
      snapshotOid: snapshot.snapshotOid,
      remotes,
    };
  });

  const handleSyncRequested = Effect.fn("MirrorAgent.handleSyncRequested")(function* (
    link: MirrorLink,
    directive: Extract<MirrorDirective, { type: "sync-requested" }>,
  ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
    const gitFailed = (cause: { readonly message: string }) =>
      new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId: directive.syncId,
        detail: cause.message,
      });
    if (directive.baseSnapshotOid === null) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId: directive.syncId,
        detail: "Host requested an incremental sync without a base snapshot; reseed required.",
      });
    }
    const baseOid = directive.baseSnapshotOid;
    const includePaths = yield* includePathsFor(link.localRoot);
    const snapshot = yield* gitSync
      .createSnapshot({ root: link.localRoot, syncId: directive.syncId, includePaths })
      .pipe(Effect.mapError(gitFailed));
    const baseTree = yield* gitSync
      .treeOfCommit(link.localRoot, baseOid)
      .pipe(Effect.mapError(gitFailed));
    if (baseTree !== null && baseTree === snapshot.treeOid) {
      yield* gitSync
        .pruneSnapshotRefs({ root: link.localRoot, keepOids: [baseOid] })
        .pipe(Effect.ignore);
      return { type: "sync-no-change", syncId: directive.syncId, snapshotOid: baseOid };
    }
    if (baseTree === null) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId: directive.syncId,
        detail: `Base snapshot ${baseOid} is missing from the origin repository; reseed required.`,
      });
    }
    const bundlePath = agentStagingPath(directive.syncId);
    yield* gitSync
      .createIncrementalBundle({
        root: link.localRoot,
        bundlePath,
        baseOid,
        snapshotRef: `refs/t3/mirror/snapshots/${directive.syncId}`,
        includeBranches: true,
      })
      .pipe(Effect.mapError(gitFailed));
    yield* uploadBundle(link, directive.uploadUrl, bundlePath).pipe(
      Effect.ensuring(fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore)),
    );
    yield* gitSync
      .pruneSnapshotRefs({
        root: link.localRoot,
        keepOids: [baseOid, snapshot.snapshotOid],
      })
      .pipe(Effect.ignore);
    return { type: "sync-uploaded", syncId: directive.syncId, snapshotOid: snapshot.snapshotOid };
  });

  const handleApplyRequested = Effect.fn("MirrorAgent.handleApplyRequested")(function* (
    link: MirrorLink,
    directive: Extract<MirrorDirective, { type: "apply-requested" }>,
  ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
    const gitFailed = (cause: { readonly message: string }) =>
      new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId: directive.syncId,
        detail: cause.message,
      });
    const bundlePath = agentStagingPath(directive.syncId);
    yield* downloadBundle(link, directive.downloadUrl, bundlePath);
    yield* gitSync
      .fetchBundle({
        root: link.localRoot,
        bundlePath,
        refspecs: [
          "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
          "+refs/heads/*:refs/t3/mirror/incoming/*",
        ],
      })
      .pipe(
        Effect.mapError(gitFailed),
        Effect.ensuring(fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore)),
      );
    const includePaths = yield* includePathsFor(link.localRoot);
    const apply = yield* gitSync
      .applySnapshot({
        root: link.localRoot,
        syncId: directive.syncId,
        baseOid: directive.baseSnapshotOid,
        targetOid: directive.targetSnapshotOid,
        includePaths,
        // The user's edits always win on their own machine; the agent's
        // version of a conflicted path stays reachable in .git.
        conflictPreference: "local",
      })
      .pipe(Effect.mapError(gitFailed));

    // Fast-forward the checked-out branch only after a clean apply, so the
    // working tree, index, and HEAD agree; a mixed reset reconciles the index.
    const currentBranch = yield* gitSync
      .symbolicHead(link.localRoot)
      .pipe(Effect.orElseSucceed(() => null));
    let refUpdates = directive.refUpdates;
    if (currentBranch !== null && apply.outcome === "applied") {
      const currentUpdate = directive.refUpdates.find((update) => update.ref === currentBranch);
      if (currentUpdate !== undefined) {
        yield* gitSync
          .applyBranchUpdatesToCurrent({
            root: link.localRoot,
            ref: currentUpdate.ref,
            oid: currentUpdate.oid,
          })
          .pipe(Effect.ignore);
        refUpdates = directive.refUpdates.filter((update) => update.ref !== currentBranch);
      }
    }
    yield* gitSync
      .applyBranchUpdates({ root: link.localRoot, refUpdates })
      .pipe(Effect.mapError(gitFailed));
    // The incoming namespace only existed to fetch the branch objects.
    const incoming = yield* gitSync
      .listRefs(link.localRoot, "refs/t3/mirror/incoming")
      .pipe(Effect.orElseSucceed(() => []));
    for (const entry of incoming) {
      yield* gitSync.updateRef(link.localRoot, entry.ref, null).pipe(Effect.ignore);
    }
    yield* gitSync
      .pruneSnapshotRefs({
        root: link.localRoot,
        keepOids: [directive.targetSnapshotOid],
      })
      .pipe(Effect.ignore);
    return {
      type: "apply-result",
      syncId: directive.syncId,
      outcome: apply.outcome,
      conflictPaths: apply.conflictPaths,
    };
  });

  const handleDirective = (
    link: MirrorLink,
    directive: MirrorDirective,
  ): Effect.Effect<MirrorAgentResponse | null, MirrorSyncFailedError> => {
    switch (directive.type) {
      case "seed-requested":
        return handleSeedRequested(link, directive);
      case "sync-requested":
        return handleSyncRequested(link, directive);
      case "apply-requested":
        return handleApplyRequested(link, directive);
      case "link-revoked":
        return Effect.succeed(null);
    }
  };

  // --- connection loop -------------------------------------------------------

  const runConnection = Effect.fn("MirrorAgent.runConnection")(function* (
    link: MirrorLink,
    token: string,
  ) {
    const ticket = yield* issueTicket(link, token);
    const socketUrl = hostWsUrl(link.hostUrl, ticket);
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(socketUrl, { openTimeout: Duration.seconds(15) }).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const connectionIdRef = yield* Ref.make<string | null>(null);
      const revoked = yield* Ref.make(false);
      yield* client[WS_METHODS.mirrorConnect]({ projectId: link.projectId }).pipe(
        Stream.runForEach((event: MirrorStreamEvent) =>
          Effect.gen(function* () {
            if (event.type === "connected") {
              yield* Ref.set(connectionIdRef, event.connectionId);
              yield* Effect.logInfo("Mirror agent connected to host.", {
                projectId: link.projectId,
                needsSeed: event.needsSeed,
              });
              return;
            }
            const connectionId = yield* Ref.get(connectionIdRef);
            if (connectionId === null || event.connectionId !== connectionId) return;
            if (event.directive.type === "link-revoked") {
              yield* Ref.set(revoked, true);
              return yield* new MirrorSyncFailedError({
                projectId: link.projectId,
                detail: "The host revoked this mirror link.",
              });
            }
            const response = yield* handleDirective(link, event.directive).pipe(
              Effect.catchTag("MirrorSyncFailedError", (error) =>
                Effect.succeed<MirrorAgentResponse>({
                  type: "sync-failed",
                  syncId: event.directive.type === "link-revoked" ? "" : event.directive.syncId,
                  message: error.detail,
                }),
              ),
            );
            if (response !== null) {
              yield* client[WS_METHODS.mirrorRespond]({ connectionId, response });
            }
          }),
        ),
      );
      const wasRevoked = yield* Ref.get(revoked);
      if (wasRevoked) {
        yield* deleteLink(link.projectId);
      }
    }).pipe(Effect.provide(protocolLayer), Effect.scoped);
  });

  const runAgent = (link: MirrorLink) =>
    Effect.gen(function* () {
      const tokenBytes = yield* secretStore.get(linkTokenSecretName(link.projectId)).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (tokenBytes === null) {
        yield* Effect.logWarning("Mirror link has no stored token; agent not started.", {
          projectId: link.projectId,
        });
        return;
      }
      const token = new TextDecoder().decode(tokenBytes);
      yield* runConnection(link, token).pipe(
        Effect.tapCause((cause) =>
          Effect.logInfo("Mirror agent connection ended; reconnecting.", {
            projectId: link.projectId,
            cause: String(cause),
          }),
        ),
        Effect.retry(RECONNECT_SCHEDULE),
      );
    });

  const startAgent = Effect.fn("MirrorAgent.startAgent")(function* (link: MirrorLink) {
    yield* stopAgent(link.projectId);
    const fiber = yield* runAgent(link).pipe(Effect.forkIn(managerScope));
    yield* SynchronizedRef.update(agents, (current) => {
      const next = new Map(current);
      next.set(link.projectId, fiber);
      return next;
    });
  });

  const stopAgent = Effect.fn("MirrorAgent.stopAgent")(function* (projectId: string) {
    const fiber = yield* SynchronizedRef.modify(agents, (current) => {
      const fiber = current.get(projectId);
      if (!fiber) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(projectId);
      return [fiber, next] as const;
    });
    if (fiber) yield* Fiber.interrupt(fiber);
  });

  // --- public API --------------------------------------------------------------

  const attach: MirrorAgentManager["Service"]["attach"] = Effect.fn("MirrorAgentManager.attach")(
    function* (input) {
      const localRoot = path.resolve(input.localRootPath);
      const isRepo = yield* gitSync.isRepository(localRoot).pipe(Effect.orElseSucceed(() => false));
      if (!isRepo) {
        // A plain folder is a valid origin. The sync protocol only needs *a*
        // repository to snapshot into, so create one in place rather than
        // refusing the folder — the host does the same for its mirror.
        yield* gitSync
          .initRepository(localRoot)
          .pipe(
            Effect.mapError(
              (cause) => new MirrorNotARepositoryError({ path: localRoot, detail: cause.message }),
            ),
          );
        yield* Effect.logInfo("Initialized a git repository for a plain mirror origin folder.", {
          projectId: input.projectId,
          localRoot,
        });
      }
      yield* secretStore
        .set(linkTokenSecretName(input.projectId), new TextEncoder().encode(input.token))
        .pipe(
          Effect.mapError(
            (cause) =>
              new MirrorSyncFailedError({
                projectId: input.projectId,
                detail: `Failed to store the mirror link token: ${cause.message}`,
              }),
          ),
        );
      const link: MirrorLink = {
        projectId: input.projectId,
        hostUrl: input.hostUrl,
        localRoot,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* saveLink(link);
      yield* startAgent(link);
    },
  );

  const detach: MirrorAgentManager["Service"]["detach"] = Effect.fn("MirrorAgentManager.detach")(
    function* (input) {
      const links = yield* loadLinks;
      const link = links.find((candidate) => candidate.projectId === input.projectId);
      if (!link) {
        return yield* new MirrorLinkNotFoundError({ projectId: input.projectId });
      }
      yield* stopAgent(input.projectId);
      yield* secretStore.remove(linkTokenSecretName(input.projectId)).pipe(Effect.ignore);
      yield* deleteLink(input.projectId);
    },
  );

  const startPersisted: MirrorAgentManager["Service"]["startPersisted"] = Effect.gen(function* () {
    const links = yield* loadLinks;
    for (const link of links) {
      yield* startAgent(link);
    }
  });

  const listLinks: MirrorAgentManager["Service"]["listLinks"] = loadLinks;

  return MirrorAgentManager.of({ attach, detach, startPersisted, listLinks });
});

export const layer = Layer.effect(MirrorAgentManager, make);

/** Inert MirrorAgentManager for tests that never attach a mirror link. */
export const layerTest = Layer.succeed(
  MirrorAgentManager,
  MirrorAgentManager.of({
    attach: (input) =>
      Effect.fail(
        new MirrorSyncFailedError({
          projectId: input.projectId,
          detail: "Mirror links are not available in this test environment.",
        }),
      ),
    detach: (input) => Effect.fail(new MirrorLinkNotFoundError({ projectId: input.projectId })),
    startPersisted: Effect.void,
    listLinks: Effect.succeed([]),
  }),
);
