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

/**
 * Bounded description of a failed HTTP request to the host, safe to surface
 * in status and logs. `String(cause)` on an HttpClientError normally embeds
 * the full request URL, which for bundle transfer requests is the
 * single-use HMAC-signed token — so it must never be interpolated directly.
 */
const describeHttpFailure = (cause: unknown): string => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String((cause as { _tag: unknown })._tag)
      : "RequestFailed";
  const reason =
    typeof cause === "object" && cause !== null && "reason" in cause
      ? String((cause as { reason: unknown }).reason)
      : null;
  return reason ? `${tag}: ${reason}` : tag;
};

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
  // Extra include patterns the host sent on its most recent "connected"
  // event for a project, keyed by projectId. Populated per-connection and
  // consulted by the directive handlers below, which only know their `link`.
  const extraIncludePathsByProject = yield* SynchronizedRef.make<
    ReadonlyMap<string, ReadonlyArray<string>>
  >(new Map());
  const includePathsWithExtra = (link: MirrorLink, root: string) =>
    Effect.gen(function* () {
      const localPaths = yield* includePathsFor(root);
      const extraByProject = yield* SynchronizedRef.get(extraIncludePathsByProject);
      const extraPaths = extraByProject.get(link.projectId) ?? [];
      return extraPaths.length === 0 ? localPaths : [...new Set([...localPaths, ...extraPaths])];
    });

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
              detail: `Websocket ticket request failed: ${describeHttpFailure(cause)}`,
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
            detail: `Bundle upload failed: ${describeHttpFailure(cause)}`,
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
            detail: `Bundle download failed: ${describeHttpFailure(cause)}`,
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

  /** Shared body of seed-requested/submodule-seed-requested, parameterized by root. */
  const seedRoot = Effect.fn("MirrorAgent.seedRoot")(function* (
    link: MirrorLink,
    root: string,
    syncId: string,
    uploadUrl: string,
  ): Effect.fn.Return<
    {
      readonly headRef: string | null;
      readonly snapshotOid: string;
      readonly remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>;
    },
    MirrorSyncFailedError
  > {
    const gitFailed = (cause: { readonly message: string }) =>
      new MirrorSyncFailedError({ projectId: link.projectId, syncId, detail: cause.message });
    const includePaths = yield* includePathsWithExtra(link, root);
    const snapshot = yield* gitSync
      .createSnapshot({ root, syncId, includePaths })
      .pipe(Effect.mapError(gitFailed));
    const bundlePath = agentStagingPath(syncId);
    yield* gitSync
      .createSeedBundle({ root, bundlePath, snapshotRef: `refs/t3/mirror/snapshots/${syncId}` })
      .pipe(Effect.mapError(gitFailed));
    yield* uploadBundle(link, uploadUrl, bundlePath).pipe(
      Effect.ensuring(fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore)),
    );
    const headRef = yield* gitSync.symbolicHead(root).pipe(Effect.mapError(gitFailed));
    const remotes = yield* gitSync.listRemotes(root).pipe(Effect.mapError(gitFailed));
    yield* gitSync
      .pruneSnapshotRefs({ root, keepOids: [snapshot.snapshotOid] })
      .pipe(Effect.ignore);
    return { headRef, snapshotOid: snapshot.snapshotOid, remotes };
  });

  const handleSeedRequested = Effect.fn("MirrorAgent.handleSeedRequested")(function* (
    link: MirrorLink,
    directive: Extract<MirrorDirective, { type: "seed-requested" }>,
  ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
    const result = yield* seedRoot(link, link.localRoot, directive.syncId, directive.uploadUrl);
    return { type: "seed-uploaded", syncId: directive.syncId, ...result };
  });

  /** Shared body of sync-requested/submodule-sync-requested, parameterized by root. */
  const syncRoot = Effect.fn("MirrorAgent.syncRoot")(function* (
    link: MirrorLink,
    root: string,
    syncId: string,
    baseSnapshotOid: string | null,
    uploadUrl: string,
  ): Effect.fn.Return<
    | { readonly noChange: true; readonly snapshotOid: string }
    | { readonly noChange: false; readonly snapshotOid: string },
    MirrorSyncFailedError
  > {
    const gitFailed = (cause: { readonly message: string }) =>
      new MirrorSyncFailedError({ projectId: link.projectId, syncId, detail: cause.message });
    if (baseSnapshotOid === null) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId,
        detail: "Host requested an incremental sync without a base snapshot; reseed required.",
      });
    }
    const includePaths = yield* includePathsWithExtra(link, root);
    const snapshot = yield* gitSync
      .createSnapshot({ root, syncId, includePaths })
      .pipe(Effect.mapError(gitFailed));
    const baseTree = yield* gitSync
      .treeOfCommit(root, baseSnapshotOid)
      .pipe(Effect.mapError(gitFailed));
    if (baseTree !== null && baseTree === snapshot.treeOid) {
      yield* gitSync.pruneSnapshotRefs({ root, keepOids: [baseSnapshotOid] }).pipe(Effect.ignore);
      return { noChange: true, snapshotOid: baseSnapshotOid };
    }
    if (baseTree === null) {
      return yield* new MirrorSyncFailedError({
        projectId: link.projectId,
        syncId,
        detail: `Base snapshot ${baseSnapshotOid} is missing from the origin repository; reseed required.`,
      });
    }
    const bundlePath = agentStagingPath(syncId);
    yield* gitSync
      .createIncrementalBundle({
        root,
        bundlePath,
        baseOid: baseSnapshotOid,
        snapshotRef: `refs/t3/mirror/snapshots/${syncId}`,
        includeBranches: true,
      })
      .pipe(Effect.mapError(gitFailed));
    yield* uploadBundle(link, uploadUrl, bundlePath).pipe(
      Effect.ensuring(fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore)),
    );
    yield* gitSync
      .pruneSnapshotRefs({ root, keepOids: [baseSnapshotOid, snapshot.snapshotOid] })
      .pipe(Effect.ignore);
    return { noChange: false, snapshotOid: snapshot.snapshotOid };
  });

  const handleSyncRequested = Effect.fn("MirrorAgent.handleSyncRequested")(function* (
    link: MirrorLink,
    directive: Extract<MirrorDirective, { type: "sync-requested" }>,
  ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
    const result = yield* syncRoot(
      link,
      link.localRoot,
      directive.syncId,
      directive.baseSnapshotOid,
      directive.uploadUrl,
    );
    return result.noChange
      ? { type: "sync-no-change", syncId: directive.syncId, snapshotOid: result.snapshotOid }
      : { type: "sync-uploaded", syncId: directive.syncId, snapshotOid: result.snapshotOid };
  });

  /** Shared body of apply-requested/submodule-apply-requested, parameterized by root. */
  const applyRoot = Effect.fn("MirrorAgent.applyRoot")(function* (
    link: MirrorLink,
    root: string,
    syncId: string,
    downloadUrl: string,
    baseSnapshotOid: string,
    targetSnapshotOid: string,
    refUpdates: ReadonlyArray<{ readonly ref: string; readonly oid: string }>,
  ): Effect.fn.Return<
    {
      readonly outcome: "applied" | "conflicted";
      readonly conflictPaths: ReadonlyArray<string>;
    },
    MirrorSyncFailedError
  > {
    const gitFailed = (cause: { readonly message: string }) =>
      new MirrorSyncFailedError({ projectId: link.projectId, syncId, detail: cause.message });
    const bundlePath = agentStagingPath(syncId);
    yield* downloadBundle(link, downloadUrl, bundlePath);
    yield* gitSync
      .fetchBundle({
        root,
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
    const includePaths = yield* includePathsWithExtra(link, root);
    const apply = yield* gitSync
      .applySnapshot({
        root,
        syncId,
        baseOid: baseSnapshotOid,
        targetOid: targetSnapshotOid,
        includePaths,
        // The user's edits always win on their own machine; the agent's
        // version of a conflicted path stays reachable in .git.
        conflictPreference: "local",
      })
      .pipe(Effect.mapError(gitFailed));

    // Fast-forward the checked-out branch only after a clean apply, so the
    // working tree, index, and HEAD agree; a mixed reset reconciles the index.
    const currentBranch = yield* gitSync.symbolicHead(root).pipe(Effect.orElseSucceed(() => null));
    let remainingRefUpdates = refUpdates;
    if (currentBranch !== null && apply.outcome === "applied") {
      const currentUpdate = refUpdates.find((update) => update.ref === currentBranch);
      if (currentUpdate !== undefined) {
        yield* gitSync
          .applyBranchUpdatesToCurrent({ root, ref: currentUpdate.ref, oid: currentUpdate.oid })
          .pipe(Effect.mapError(gitFailed));
        remainingRefUpdates = refUpdates.filter((update) => update.ref !== currentBranch);
      }
    }
    yield* gitSync
      .applyBranchUpdates({ root, refUpdates: remainingRefUpdates })
      .pipe(Effect.mapError(gitFailed));
    // The incoming namespace only existed to fetch the branch objects.
    const incoming = yield* gitSync
      .listRefs(root, "refs/t3/mirror/incoming")
      .pipe(Effect.orElseSucceed(() => []));
    for (const entry of incoming) {
      yield* gitSync.updateRef(root, entry.ref, null).pipe(Effect.ignore);
    }
    yield* gitSync.pruneSnapshotRefs({ root, keepOids: [targetSnapshotOid] }).pipe(Effect.ignore);
    return { outcome: apply.outcome, conflictPaths: apply.conflictPaths };
  });

  const handleApplyRequested = Effect.fn("MirrorAgent.handleApplyRequested")(function* (
    link: MirrorLink,
    directive: Extract<MirrorDirective, { type: "apply-requested" }>,
  ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
    const result = yield* applyRoot(
      link,
      link.localRoot,
      directive.syncId,
      directive.downloadUrl,
      directive.baseSnapshotOid,
      directive.targetSnapshotOid,
      directive.refUpdates,
    );
    return { type: "apply-result", syncId: directive.syncId, ...result };
  });

  // --- submodule directive handlers -------------------------------------------

  /**
   * Joins a host-supplied submodule path to the project root and rejects
   * anything that escapes it (e.g. `../other-repository`), so a compromised
   * host can't point the origin agent at an arbitrary local directory.
   */
  const resolveSubmoduleRoot = (link: MirrorLink, submodulePath: string) =>
    Effect.gen(function* () {
      const localRoot = path.resolve(link.localRoot);
      const root = path.resolve(localRoot, submodulePath);
      if (root !== localRoot && !root.startsWith(localRoot + path.sep)) {
        return yield* new MirrorSyncFailedError({
          projectId: link.projectId,
          detail: "Submodule path escapes the project root.",
        });
      }
      return root;
    });

  const handleSubmoduleSeedRequested = Effect.fn("MirrorAgent.handleSubmoduleSeedRequested")(
    function* (
      link: MirrorLink,
      directive: Extract<MirrorDirective, { type: "submodule-seed-requested" }>,
    ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
      const root = yield* resolveSubmoduleRoot(link, directive.path);
      const isRepo = yield* gitSync.isRepository(root).pipe(Effect.orElseSucceed(() => false));
      if (!isRepo) {
        return {
          type: "submodule-skipped",
          syncId: directive.syncId,
          path: directive.path,
          reason: "no-nested-repository",
          detail: "No git repository found at this path on the origin machine.",
        };
      }
      const result = yield* seedRoot(link, root, directive.syncId, directive.uploadUrl);
      return {
        type: "submodule-seed-uploaded",
        syncId: directive.syncId,
        path: directive.path,
        ...result,
      };
    },
  );

  const handleSubmoduleSyncRequested = Effect.fn("MirrorAgent.handleSubmoduleSyncRequested")(
    function* (
      link: MirrorLink,
      directive: Extract<MirrorDirective, { type: "submodule-sync-requested" }>,
    ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
      const root = yield* resolveSubmoduleRoot(link, directive.path);
      const isRepo = yield* gitSync.isRepository(root).pipe(Effect.orElseSucceed(() => false));
      if (!isRepo) {
        return {
          type: "submodule-skipped",
          syncId: directive.syncId,
          path: directive.path,
          reason: "no-nested-repository",
          detail: "No git repository found at this path on the origin machine.",
        };
      }
      const result = yield* syncRoot(
        link,
        root,
        directive.syncId,
        directive.baseSnapshotOid,
        directive.uploadUrl,
      );
      return result.noChange
        ? {
            type: "submodule-sync-no-change",
            syncId: directive.syncId,
            path: directive.path,
            snapshotOid: result.snapshotOid,
          }
        : {
            type: "submodule-sync-uploaded",
            syncId: directive.syncId,
            path: directive.path,
            snapshotOid: result.snapshotOid,
          };
    },
  );

  const handleSubmoduleApplyRequested = Effect.fn("MirrorAgent.handleSubmoduleApplyRequested")(
    function* (
      link: MirrorLink,
      directive: Extract<MirrorDirective, { type: "submodule-apply-requested" }>,
    ): Effect.fn.Return<MirrorAgentResponse, MirrorSyncFailedError> {
      const root = yield* resolveSubmoduleRoot(link, directive.path);
      const isRepo = yield* gitSync.isRepository(root).pipe(Effect.orElseSucceed(() => false));
      if (!isRepo) {
        return {
          type: "submodule-skipped",
          syncId: directive.syncId,
          path: directive.path,
          reason: "no-nested-repository",
          detail: "No git repository found at this path on the origin machine.",
        };
      }
      const result = yield* applyRoot(
        link,
        root,
        directive.syncId,
        directive.downloadUrl,
        directive.baseSnapshotOid,
        directive.targetSnapshotOid,
        directive.refUpdates,
      );
      return {
        type: "submodule-apply-result",
        syncId: directive.syncId,
        path: directive.path,
        ...result,
      };
    },
  );

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
      case "submodule-seed-requested":
        return handleSubmoduleSeedRequested(link, directive);
      case "submodule-sync-requested":
        return handleSubmoduleSyncRequested(link, directive);
      case "submodule-apply-requested":
        return handleSubmoduleApplyRequested(link, directive);
      case "link-revoked":
        return Effect.succeed(null);
    }
  };

  /** syncId to fall back to a submodule-skipped response for, when known. */
  const directiveSyncId = (directive: MirrorDirective): string | null =>
    directive.type === "link-revoked" ? null : directive.syncId;

  const isSubmoduleDirective = (
    directive: MirrorDirective,
  ): directive is Extract<
    MirrorDirective,
    {
      type: "submodule-seed-requested" | "submodule-sync-requested" | "submodule-apply-requested";
    }
  > =>
    directive.type === "submodule-seed-requested" ||
    directive.type === "submodule-sync-requested" ||
    directive.type === "submodule-apply-requested";

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
      yield* client[WS_METHODS.mirrorConnect]({
        projectId: link.projectId,
        supportsSubmodules: true,
      }).pipe(
        Stream.runForEach((event: MirrorStreamEvent) =>
          Effect.gen(function* () {
            if (event.type === "connected") {
              yield* Ref.set(connectionIdRef, event.connectionId);
              yield* SynchronizedRef.update(extraIncludePathsByProject, (current) => {
                const next = new Map(current);
                next.set(link.projectId, event.extraIncludePaths ?? []);
                return next;
              });
              yield* Effect.logInfo("Mirror agent connected to host.", {
                projectId: link.projectId,
                needsSeed: event.needsSeed,
              });
              return;
            }
            if (event.type === "settings-updated") {
              const activeConnectionId = yield* Ref.get(connectionIdRef);
              if (activeConnectionId !== null && event.connectionId === activeConnectionId) {
                yield* SynchronizedRef.update(extraIncludePathsByProject, (current) => {
                  const next = new Map(current);
                  next.set(link.projectId, event.extraIncludePaths);
                  return next;
                });
              }
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
            const directive = event.directive;
            const response = yield* handleDirective(link, directive).pipe(
              Effect.catchTags({
                MirrorSyncFailedError: (error) =>
                  Effect.succeed<MirrorAgentResponse>(
                    isSubmoduleDirective(directive)
                      ? {
                          type: "submodule-skipped",
                          syncId: directive.syncId,
                          path: directive.path,
                          reason: "error",
                          detail: error.detail,
                        }
                      : {
                          type: "sync-failed",
                          syncId: directiveSyncId(directive) ?? "",
                          message: error.detail,
                        },
                  ),
              }),
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
        Effect.retry({
          // "Not a mirrored project" is the host's definitive answer for a
          // stale link (the project was deleted or detached there):
          // reconnecting can never succeed, so stop instead of retrying
          // every 15 seconds forever. The link row is kept — a transient
          // host-side read hiccup reports the same tag, and a real re-attach
          // restarts the agent anyway.
          while: (error) => error._tag !== "MirrorProjectNotMirroredError",
          schedule: RECONNECT_SCHEDULE,
        }),
        Effect.catchTags({
          MirrorProjectNotMirroredError: (error) =>
            Effect.logWarning("Mirror link is stale on the host; agent stopped.", {
              projectId: link.projectId,
              detail: error.message,
            }),
        }),
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
