import {
  AuthFederationPeerScope,
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  EnvironmentHttpApi,
  FEDERATION_PEER_CODE_DEFAULT_TTL_SECONDS,
  FEDERATION_PEER_CODE_PAIRING_SUBJECT,
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_SESSION_SUBJECT_PREFIX,
  type FederationAddPeerInput,
  type FederationArtifactFetchResponse,
  type FederationArtifactsResponse,
  type FederationCapability,
  type FederationChallengeRequest,
  type FederationChallengeResponse,
  type FederationCreatePeerCodeInput,
  FederationError,
  type FederationHello,
  type FederationPairRequest,
  type FederationPairResponse,
  type FederationPeer,
  type FederationPeerCodeResult,
  type FederationProjectsResponse,
  type FederationRemoteArtifactInput,
  type FederationRemoteRun,
  type FederationRemoteRunInput,
  type FederationRemoteRunsSnapshot,
  type FederationRun,
  type FederationRunEventsResponse,
  type FederationRunStartRequest,
  type FederationScope,
  type FederationSnapshot,
  type FederationStartRemoteRunInput,
  type FederationTokenRequest,
  type FederationTokenResponse,
  type ModelSelection,
  MessageId,
  ProviderInstanceId,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  type TurnId,
} from "@t3tools/contracts";
import {
  T3ConnectionCodeInvalidError,
  decodeFederationPeerCode,
  encodeFederationPeerCode,
} from "@t3tools/shared/t3ConnectionCode";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TailcatRemoteAccess from "../tailcat/TailcatRemoteAccess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as FederationIdentity from "./FederationIdentity.ts";
import * as FederationPeerStore from "./FederationPeerStore.ts";
import * as FederationTransport from "./FederationTransport.ts";
import {
  isFederationRunActive,
  projectFederationArtifacts,
  projectFederationRun,
  summarizeFederationRunEvent,
  truncatePreview,
} from "./runProjection.ts";

/**
 * FederationService is the T3 federation protocol, both halves:
 *
 *   - as an issuer/peer-facing server it pairs requesters that redeem a peer
 *     code, answers signed challenges with federation sessions, and serves the
 *     explicit, scope-checked federation endpoints;
 *   - as a requester it pairs with peers from their codes, keeps a session per
 *     peer, and coordinates runs that stay owned by the peer that executes them.
 *
 * Transport is Tailcat (FederationTransport). Authentication is this
 * environment's Ed25519 identity (FederationIdentity) plus ordinary T3 sessions
 * scoped to `federation:peer`. Authorization is the per-peer scope grant made
 * at pairing time; a transport path never implies trust by itself.
 */

export const FEDERATION_CAPABILITIES: ReadonlyArray<FederationCapability> = [
  "hello",
  "projects.list",
  "runs.start",
  "runs.status",
  "runs.cancel",
  "runs.events",
  "artifacts.describe",
  "artifacts.fetch",
];

const FEDERATION_SESSION_TTL = Duration.hours(1);
const FEDERATION_SESSION_REFRESH_SKEW = Duration.minutes(2);
const CHALLENGE_TTL = Duration.minutes(2);
const REMOTE_RUN_POLL_INTERVAL = Duration.seconds(2);
const REMOTE_RUN_EVENT_LIMIT = 200;
const PEER_REFRESH_INTERVAL = Duration.minutes(5);
const PEER_REQUEST_TIMEOUT = Duration.seconds(20);
const DEFAULT_REMOTE_RUNTIME_MODE = "auto" as const;

export class FederationService extends Context.Service<
  FederationService,
  {
    // Local owner operations (driven over RPC by this environment's clients)
    readonly snapshot: Effect.Effect<FederationSnapshot>;
    readonly changes: Stream.Stream<FederationSnapshot>;
    readonly remoteRuns: Effect.Effect<FederationRemoteRunsSnapshot>;
    readonly remoteRunChanges: Stream.Stream<FederationRemoteRunsSnapshot>;
    readonly createPeerCode: (
      input: FederationCreatePeerCodeInput,
    ) => Effect.Effect<FederationPeerCodeResult, FederationError>;
    readonly addPeer: (
      input: FederationAddPeerInput,
    ) => Effect.Effect<FederationPeer, FederationError>;
    readonly removePeer: (peerId: EnvironmentId) => Effect.Effect<void, FederationError>;
    readonly refreshPeer: (peerId: EnvironmentId) => Effect.Effect<FederationPeer, FederationError>;
    readonly listRemoteProjects: (
      peerId: EnvironmentId,
    ) => Effect.Effect<FederationProjectsResponse, FederationError>;
    readonly startRemoteRun: (
      input: FederationStartRemoteRunInput,
    ) => Effect.Effect<FederationRemoteRun, FederationError>;
    readonly cancelRemoteRun: (
      input: FederationRemoteRunInput,
    ) => Effect.Effect<FederationRemoteRun, FederationError>;
    readonly describeRemoteArtifacts: (
      input: FederationRemoteRunInput,
    ) => Effect.Effect<FederationArtifactsResponse, FederationError>;
    readonly fetchRemoteArtifact: (
      input: FederationRemoteArtifactInput,
    ) => Effect.Effect<FederationArtifactFetchResponse, FederationError>;
    // Peer-facing protocol operations (driven by the federation HTTP group)
    readonly acceptPair: (
      request: FederationPairRequest,
    ) => Effect.Effect<FederationPairResponse, FederationError>;
    readonly issueChallenge: (
      request: FederationChallengeRequest,
    ) => Effect.Effect<FederationChallengeResponse, FederationError>;
    readonly redeemChallenge: (
      request: FederationTokenRequest,
    ) => Effect.Effect<FederationTokenResponse, FederationError>;
    readonly authorizePeer: (
      principal: { readonly subject: string; readonly scopes: ReadonlySet<string> },
      required: FederationScope,
    ) => Effect.Effect<FederationPeerStore.PersistedFederationPeer, FederationError>;
    readonly hello: Effect.Effect<FederationHello>;
    readonly localProjects: Effect.Effect<FederationProjectsResponse, FederationError>;
    readonly startLocalRun: (
      peer: FederationPeerStore.PersistedFederationPeer,
      request: FederationRunStartRequest,
    ) => Effect.Effect<FederationRun, FederationError>;
    readonly localRunStatus: (
      peer: FederationPeerStore.PersistedFederationPeer,
      threadId: ThreadId,
    ) => Effect.Effect<FederationRun, FederationError>;
    readonly cancelLocalRun: (
      peer: FederationPeerStore.PersistedFederationPeer,
      threadId: ThreadId,
    ) => Effect.Effect<FederationRun, FederationError>;
    readonly localRunEvents: (
      peer: FederationPeerStore.PersistedFederationPeer,
      threadId: ThreadId,
      afterSequence: number,
    ) => Effect.Effect<FederationRunEventsResponse, FederationError>;
    readonly localRunArtifacts: (
      peer: FederationPeerStore.PersistedFederationPeer,
      threadId: ThreadId,
    ) => Effect.Effect<FederationArtifactsResponse, FederationError>;
    readonly fetchLocalArtifact: (
      peer: FederationPeerStore.PersistedFederationPeer,
      threadId: ThreadId,
      turnId: TurnId,
    ) => Effect.Effect<FederationArtifactFetchResponse, FederationError>;
  }
>()("t3/federation/FederationService") {}

interface PendingChallenge {
  readonly peerId: EnvironmentId;
  readonly expiresAtMs: number;
}

interface PeerSession {
  readonly token: string;
  readonly expiresAtMs: number;
}

const internalError = (message: string) => new FederationError({ code: "internal", message });
const isFederationError = Schema.is(FederationError);
const isConnectionCodeInvalidError = Schema.is(T3ConnectionCodeInvalidError);

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

function scopesIncludeAll(
  granted: ReadonlyArray<FederationScope>,
  required: ReadonlyArray<FederationScope>,
): boolean {
  return required.every((scope) => granted.includes(scope));
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const identity = yield* FederationIdentity.FederationIdentity;
  const peers = yield* FederationPeerStore.FederationPeerStore;
  const transport = yield* FederationTransport.FederationTransport;
  const tailcat = yield* TailcatRemoteAccess.TailcatRemoteAccess;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointDiffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const serviceScope = yield* Scope.Scope;

  const pendingPeerCodes = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<FederationScope>>>(
    new Map(),
  );
  const challenges = yield* Ref.make<ReadonlyMap<string, PendingChallenge>>(new Map());
  const peerSessions = yield* Ref.make<ReadonlyMap<EnvironmentId, PeerSession>>(new Map());
  const pollSignals = yield* Queue.unbounded<"poll">();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const buildSnapshot = Effect.gen(function* () {
    const stored = yield* peers.peers;
    const presented = yield* Effect.forEach(stored, peers.presentPeer);
    return {
      environmentId: identity.environmentId,
      publicKeyFingerprint: identity.fingerprint,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      peers: presented.toSorted((left, right) => left.label.localeCompare(right.label)),
      updatedAt: yield* nowIso,
    } satisfies FederationSnapshot;
  });
  const snapshotRef = yield* SubscriptionRef.make<FederationSnapshot>(yield* buildSnapshot);
  const publishPeers = buildSnapshot.pipe(
    Effect.flatMap((next) => SubscriptionRef.set(snapshotRef, next)),
  );

  const buildRuns = Effect.gen(function* () {
    const runs = yield* peers.remoteRuns;
    return {
      runs: runs.toSorted((left, right) =>
        right.run.requestedAt.localeCompare(left.run.requestedAt),
      ),
      updatedAt: yield* nowIso,
    } satisfies FederationRemoteRunsSnapshot;
  });
  const runsRef = yield* SubscriptionRef.make<FederationRemoteRunsSnapshot>(yield* buildRuns);
  const publishRuns = buildRuns.pipe(Effect.flatMap((next) => SubscriptionRef.set(runsRef, next)));

  const storeError = (error: FederationPeerStore.FederationPeerStoreError) =>
    internalError(error.message);

  const helloEffect: FederationService["Service"]["hello"] = serverEnvironment.getDescriptor.pipe(
    Effect.map((descriptor): FederationHello => ({
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      platform: descriptor.platform,
      capabilities: FEDERATION_CAPABILITIES,
    })),
  );

  const ourTransport = tailcat.readyEndpoint.pipe(
    Effect.map((endpoint) =>
      Option.match(endpoint, {
        onNone: () => null,
        onSome: ({ address, port }) => ({ tailcat: { address, port } }),
      }),
    ),
  );

  // ── Peer-facing protocol ────────────────────────────────────────────

  const acceptPair: FederationService["Service"]["acceptPair"] = Effect.fn(
    "FederationService.acceptPair",
  )(function* (request) {
    if (request.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
      return yield* new FederationError({
        code: "protocol-incompatible",
        message: `The peer speaks federation protocol v${request.protocolVersion}; this environment speaks v${FEDERATION_PROTOCOL_VERSION}. Update the older side.`,
      });
    }
    if (request.environmentId === identity.environmentId) {
      return yield* new FederationError({
        code: "code-invalid",
        message: "An environment cannot federate with itself.",
      });
    }
    const grant = yield* pairingLinks.consume(request.token).pipe(
      Effect.mapError((error) =>
        PairingGrantStore.isBootstrapCredentialInvalidError(error)
          ? new FederationError({
              code:
                error._tag === "ExpiredBootstrapCredentialError" ? "code-expired" : "code-invalid",
              message:
                error._tag === "ExpiredBootstrapCredentialError"
                  ? "This peer code has expired. Create a new one on the other machine."
                  : "This peer code is not valid or was already used.",
            })
          : internalError(`Could not validate the peer code: ${error.message}`),
      ),
    );
    if (grant.subject !== FEDERATION_PEER_CODE_PAIRING_SUBJECT) {
      return yield* new FederationError({
        code: "code-invalid",
        message: "This code is a device pairing code, not a federation peer code.",
      });
    }
    const offered =
      grant.id === undefined ? undefined : (yield* Ref.get(pendingPeerCodes)).get(grant.id);
    if (offered === undefined) {
      return yield* new FederationError({
        code: "code-expired",
        message: "This peer code is no longer offered by this environment. Create a new one.",
      });
    }
    yield* Ref.update(pendingPeerCodes, (current) => {
      const next = new Map(current);
      next.delete(grant.id!);
      return next;
    });
    const at = yield* nowIso;
    const existing = yield* peers.getPeer(request.environmentId);
    yield* peers
      .upsertPeer({
        peerId: request.environmentId,
        label: request.label,
        publicKey: request.publicKey,
        grantedScopes: offered,
        allowedScopes: request.grantedScopes,
        transport: request.transport,
        remoteServerVersion: request.serverVersion,
        remoteProtocolVersion: request.protocolVersion,
        remoteCapabilities: request.capabilities,
        createdAt: Option.isSome(existing) ? existing.value.createdAt : at,
        lastSeenAt: at,
      })
      .pipe(Effect.mapError(storeError));
    yield* peers.setPeerStatus(request.environmentId, { status: "online", lastError: null });
    if (request.tailcatNodeKey !== undefined) {
      yield* tailcat
        .recordTrustedPeer({
          nodeKey: request.tailcatNodeKey,
          label: `Federation: ${request.label}`,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not trust the federation peer's Tailcat key.", { error }),
          ),
        );
    }
    yield* Effect.logInfo("Federation peer paired.", {
      peerId: request.environmentId,
      grantedScopes: offered,
      allowedScopes: request.grantedScopes,
    });
    yield* publishPeers;
    const descriptor = yield* serverEnvironment.getDescriptor;
    const ourNodeKey = yield* transport.clientNodeKey.pipe(Effect.option);
    return {
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      environmentId: identity.environmentId,
      publicKey: identity.publicKey,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      capabilities: FEDERATION_CAPABILITIES,
      grantedScopes: offered,
      transport: yield* ourTransport,
      ...(Option.isSome(ourNodeKey) ? { tailcatNodeKey: ourNodeKey.value } : {}),
    } satisfies FederationPairResponse;
  });

  const pruneChallenges = nowMs.pipe(
    Effect.flatMap((current) =>
      Ref.update(challenges, (pending) => {
        const next = new Map<string, PendingChallenge>();
        for (const [nonce, entry] of pending) {
          if (entry.expiresAtMs > current) next.set(nonce, entry);
        }
        return next;
      }),
    ),
  );

  const requirePeer = (peerId: EnvironmentId) =>
    peers.getPeer(peerId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new FederationError({
                code: "peer-unknown",
                message: "This environment is not paired with the requesting environment.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const issueChallenge: FederationService["Service"]["issueChallenge"] = Effect.fn(
    "FederationService.issueChallenge",
  )(function* (request) {
    yield* requirePeer(request.environmentId);
    yield* pruneChallenges;
    const bytes = yield* crypto
      .randomBytes(32)
      .pipe(Effect.mapError((cause) => internalError(describeCause(cause))));
    const challenge = Encoding.encodeBase64Url(bytes);
    const expiresAtMs = (yield* nowMs) + Duration.toMillis(CHALLENGE_TTL);
    yield* Ref.update(challenges, (pending) =>
      new Map(pending).set(challenge, { peerId: request.environmentId, expiresAtMs }),
    );
    return {
      challenge,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)),
    } satisfies FederationChallengeResponse;
  });

  const redeemChallenge: FederationService["Service"]["redeemChallenge"] = Effect.fn(
    "FederationService.redeemChallenge",
  )(function* (request) {
    const peer = yield* requirePeer(request.environmentId);
    const answered = yield* identity
      .verifyChallenge({
        assertion: request.assertion,
        issuer: request.environmentId,
        publicKey: peer.publicKey,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new FederationError({
              code: "peer-rejected",
              message: error.message,
            }),
        ),
      );
    yield* pruneChallenges;
    const pending = (yield* Ref.get(challenges)).get(answered);
    if (pending === undefined || pending.peerId !== request.environmentId) {
      return yield* new FederationError({
        code: "peer-rejected",
        message: "The federation challenge is unknown or expired. Request a new one.",
      });
    }
    yield* Ref.update(challenges, (current) => {
      const next = new Map(current);
      next.delete(answered);
      return next;
    });
    const session = yield* environmentAuth
      .issueSession({
        ttl: FEDERATION_SESSION_TTL,
        subject: `${FEDERATION_SESSION_SUBJECT_PREFIX}${peer.peerId}`,
        scopes: [AuthFederationPeerScope],
        label: `Federation: ${peer.label}`,
      })
      .pipe(Effect.mapError((error) => internalError(error.message)));
    const at = yield* nowIso;
    yield* peers.upsertPeer({ ...peer, lastSeenAt: at }).pipe(Effect.ignore);
    yield* peers.setPeerStatus(peer.peerId, { status: "online", lastError: null });
    yield* publishPeers;
    return {
      accessToken: session.token,
      expiresAt: DateTime.formatIso(session.expiresAt),
      scopes: peer.grantedScopes,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
    } satisfies FederationTokenResponse;
  });

  const authorizePeer: FederationService["Service"]["authorizePeer"] = Effect.fn(
    "FederationService.authorizePeer",
  )(function* (principal, required) {
    if (
      !principal.subject.startsWith(FEDERATION_SESSION_SUBJECT_PREFIX) ||
      !principal.scopes.has(AuthFederationPeerScope)
    ) {
      return yield* new FederationError({
        code: "peer-unknown",
        message: "This session is not a federation peer session.",
      });
    }
    const peerId = principal.subject.slice(
      FEDERATION_SESSION_SUBJECT_PREFIX.length,
    ) as EnvironmentId;
    const peer = yield* peers.getPeer(peerId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new FederationError({
                code: "peer-revoked",
                message: "This environment no longer trusts the requesting environment.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!peer.grantedScopes.includes(required)) {
      return yield* new FederationError({
        code: "scope-denied",
        message: `The requesting environment was not granted ${required}.`,
      });
    }
    yield* peers.setPeerStatus(peer.peerId, { status: "online", lastError: null });
    return peer;
  });

  const localProjects: FederationService["Service"]["localProjects"] = projections
    .getShellSnapshot()
    .pipe(
      Effect.map((snapshot): FederationProjectsResponse => ({
        environmentId: identity.environmentId,
        projects: snapshot.projects.map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          repositoryIdentity: project.repositoryIdentity ?? null,
          defaultModelSelection: project.defaultModelSelection,
        })),
      })),
      Effect.mapError((error) => internalError(`Could not list projects: ${error.message}`)),
    );

  const requireInboundRun = (
    peer: FederationPeerStore.PersistedFederationPeer,
    threadId: ThreadId,
  ) =>
    peers.inboundRuns.pipe(
      Effect.flatMap((runs) =>
        runs.some((run) => run.threadId === threadId && run.peerId === peer.peerId)
          ? Effect.void
          : Effect.fail(
              new FederationError({
                code: "run-not-found",
                message: "No federated run with that id was started by this peer.",
              }),
            ),
      ),
    );

  const projectLocalRun = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.mapError((error) => internalError(error.message)));
      if (Option.isNone(shell)) {
        return yield* new FederationError({
          code: "run-not-found",
          message: "The federated run no longer exists on this environment.",
        });
      }
      const detail = yield* projections
        .getThreadDetailById(threadId, { activityKinds: [] })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const assistantPreview = Option.match(detail, {
        onNone: () => null,
        onSome: (thread) => {
          const lastAssistant = thread.messages
            .toReversed()
            .find((message) => message.role === "assistant" && message.text.trim().length > 0);
          return lastAssistant === undefined ? null : truncatePreview(lastAssistant.text);
        },
      });
      const checkpoints = yield* projections
        .getThreadCheckpointContext(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const turnCount = Option.match(checkpoints, {
        onNone: () => 0,
        onSome: (context) =>
          context.checkpoints.reduce(
            (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
            0,
          ),
      });
      return projectFederationRun({
        environmentId: identity.environmentId,
        thread: shell.value,
        assistantPreview,
        turnCount,
      });
    });

  const dispatchClientCommand = (command: ClientOrchestrationCommand) =>
    normalizeDispatchCommand(command).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
      Effect.mapError((error) =>
        internalError(`Invalid federation command: ${describeCause(error)}`),
      ),
      Effect.flatMap((normalized) =>
        orchestrationEngine
          .dispatch(normalized)
          .pipe(Effect.mapError((error) => internalError(describeCause(error)))),
      ),
    );

  const newId = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => internalError(describeCause(cause))),
  );

  const startLocalRun: FederationService["Service"]["startLocalRun"] = Effect.fn(
    "FederationService.startLocalRun",
  )(function* (peer, request) {
    const project = yield* projections
      .getProjectShellById(request.projectId)
      .pipe(Effect.mapError((error) => internalError(error.message)));
    if (Option.isNone(project)) {
      return yield* new FederationError({
        code: "run-not-found",
        message: "That project does not exist on this environment.",
      });
    }
    const modelSelection: ModelSelection = request.modelSelection ??
      project.value.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
    const runtimeMode = request.runtimeMode ?? DEFAULT_REMOTE_RUNTIME_MODE;
    const title = request.title ?? truncatePreview(request.prompt, 60);
    const threadId = ThreadIdSchema.make(yield* newId);
    const createdAt = yield* nowIso;
    yield* dispatchClientCommand({
      type: "thread.create",
      commandId: CommandId.make(yield* newId),
      threadId,
      projectId: request.projectId,
      title,
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode,
      branch: null,
      worktreePath: null,
      createdAt,
    });
    yield* peers
      .recordInboundRun({ threadId, peerId: peer.peerId, createdAt })
      .pipe(Effect.mapError(storeError));
    yield* dispatchClientCommand({
      type: "thread.turn.start",
      commandId: CommandId.make(yield* newId),
      threadId,
      message: {
        messageId: MessageId.make(yield* newId),
        role: "user",
        text: request.prompt,
        attachments: [],
      },
      modelSelection,
      runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: yield* nowIso,
    });
    yield* Effect.logInfo("Federated run started for a peer.", {
      peerId: peer.peerId,
      threadId,
      projectId: request.projectId,
      runtimeMode,
    });
    return yield* projectLocalRun(threadId);
  });

  const localRunStatus: FederationService["Service"]["localRunStatus"] = (peer, threadId) =>
    requireInboundRun(peer, threadId).pipe(Effect.andThen(projectLocalRun(threadId)));

  const cancelLocalRun: FederationService["Service"]["cancelLocalRun"] = Effect.fn(
    "FederationService.cancelLocalRun",
  )(function* (peer, threadId) {
    yield* requireInboundRun(peer, threadId);
    const run = yield* projectLocalRun(threadId);
    if (isFederationRunActive(run)) {
      yield* dispatchClientCommand({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(yield* newId),
        threadId,
        ...(run.turnId === null ? {} : { turnId: run.turnId }),
        createdAt: yield* nowIso,
      });
    }
    return yield* projectLocalRun(threadId);
  });

  const localRunEvents: FederationService["Service"]["localRunEvents"] = Effect.fn(
    "FederationService.localRunEvents",
  )(function* (peer, threadId, afterSequence) {
    yield* requireInboundRun(peer, threadId);
    const run = yield* projectLocalRun(threadId);
    const latestSequence = yield* orchestrationEngine.latestSequence;
    const events = yield* orchestrationEngine
      .readEvents(afterSequence, Math.max(1, latestSequence - afterSequence))
      .pipe(
        Stream.map((event) => summarizeFederationRunEvent(event, threadId)),
        Stream.filter((event) => event !== null),
        Stream.runCollect,
        Effect.mapError((error) => internalError(`Could not read run events: ${error.message}`)),
      );
    return {
      run,
      events: events.slice(-REMOTE_RUN_EVENT_LIMIT),
      latestSequence,
    } satisfies FederationRunEventsResponse;
  });

  const localArtifactRefs = (threadId: ThreadId) =>
    projections.getThreadCheckpointContext(threadId).pipe(
      Effect.mapError((error) => internalError(error.message)),
      Effect.map((context) =>
        Option.match(context, {
          onNone: () => [],
          onSome: (value) =>
            projectFederationArtifacts({
              environmentId: identity.environmentId,
              threadId,
              checkpoints: value.checkpoints,
            }),
        }),
      ),
    );

  const localRunArtifacts: FederationService["Service"]["localRunArtifacts"] = Effect.fn(
    "FederationService.localRunArtifacts",
  )(function* (peer, threadId) {
    yield* requireInboundRun(peer, threadId);
    const run = yield* projectLocalRun(threadId);
    const artifacts = yield* localArtifactRefs(threadId);
    return { run, artifacts } satisfies FederationArtifactsResponse;
  });

  const fetchLocalArtifact: FederationService["Service"]["fetchLocalArtifact"] = Effect.fn(
    "FederationService.fetchLocalArtifact",
  )(function* (peer, threadId, turnId) {
    yield* requireInboundRun(peer, threadId);
    const artifacts = yield* localArtifactRefs(threadId);
    const ref = artifacts.find((artifact) => artifact.turnId === turnId);
    if (ref === undefined) {
      return yield* new FederationError({
        code: "artifact-unavailable",
        message: "That turn has no recorded changes yet.",
      });
    }
    const diff = yield* checkpointDiffs
      .getTurnDiff({ threadId, fromTurnCount: ref.fromTurnCount, toTurnCount: ref.toTurnCount })
      .pipe(
        Effect.mapError(
          (error) =>
            new FederationError({
              code: "artifact-unavailable",
              message: `Could not compute the diff: ${describeCause(error)}`,
            }),
        ),
      );
    return {
      ref,
      contentType: "text/x-diff",
      diff: diff.diff,
      fetchedAt: yield* nowIso,
    } satisfies FederationArtifactFetchResponse;
  });

  // ── Requester side ──────────────────────────────────────────────────

  const clientFor = (httpBaseUrl: string) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  type PeerClient = Effect.Success<ReturnType<typeof clientFor>>;

  const mapPeerCallError = (peerId: EnvironmentId) => (cause: unknown) =>
    Effect.gen(function* () {
      if (isFederationError(cause)) {
        if (cause.code === "peer-unknown" || cause.code === "peer-revoked") {
          yield* peers.setPeerStatus(peerId, { status: "offline", lastError: cause.message });
        }
        return cause;
      }
      const message = describeCause(cause);
      yield* peers.setPeerStatus(peerId, { status: "offline", lastError: message });
      return new FederationError({ code: "peer-unreachable", message });
    }).pipe(Effect.flatMap(Effect.fail));

  const requestSession = (peer: FederationPeerStore.PersistedFederationPeer, client: PeerClient) =>
    Effect.gen(function* () {
      const challenge = yield* client.federation.challenge({
        payload: { environmentId: identity.environmentId },
      });
      const assertion = yield* identity
        .signChallenge({ audience: peer.peerId, challenge: challenge.challenge })
        .pipe(Effect.mapError((error) => internalError(error.message)));
      const token = yield* client.federation.token({
        payload: { environmentId: identity.environmentId, assertion },
      });
      const expiresAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe(token.expiresAt));
      yield* Ref.update(peerSessions, (current) =>
        new Map(current).set(peer.peerId, { token: token.accessToken, expiresAtMs }),
      );
      return token;
    });

  const sessionFor = (peer: FederationPeerStore.PersistedFederationPeer, client: PeerClient) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(peerSessions)).get(peer.peerId);
      const current = yield* nowMs;
      if (
        cached !== undefined &&
        cached.expiresAtMs - Duration.toMillis(FEDERATION_SESSION_REFRESH_SKEW) > current
      ) {
        return cached.token;
      }
      return (yield* requestSession(peer, client)).accessToken;
    });

  const callPeer = <A, E>(
    peer: FederationPeerStore.PersistedFederationPeer,
    call: (client: PeerClient, headers: { readonly authorization: string }) => Effect.Effect<A, E>,
  ): Effect.Effect<A, FederationError> =>
    Effect.gen(function* () {
      if (peer.transport === null) {
        return yield* new FederationError({
          code: "transport-unavailable",
          message: `${peer.label} did not share a Tailcat address, so this environment cannot reach it.`,
        });
      }
      const endpoint = yield* transport.endpointFor({
        peerId: peer.peerId,
        transport: peer.transport,
      });
      const client = yield* clientFor(endpoint.httpBaseUrl).pipe(
        Effect.mapError((cause) => internalError(describeCause(cause))),
      );
      const attempt = Effect.gen(function* () {
        const token = yield* sessionFor(peer, client);
        return yield* call(client, { authorization: `Bearer ${token}` });
      });
      return yield* attempt.pipe(
        Effect.catch((cause) =>
          // One retry after a session refresh covers a revoked or expired
          // token; anything else is a real failure.
          isAuthRejection(cause)
            ? Ref.update(peerSessions, (current) => {
                const next = new Map(current);
                next.delete(peer.peerId);
                return next;
              }).pipe(Effect.andThen(attempt))
            : Effect.fail(cause),
        ),
        Effect.timeoutOrElse({
          duration: PEER_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new FederationError({
                code: "peer-unreachable",
                message: `${peer.label} did not answer in time.`,
              }),
            ),
        }),
        Effect.catch((cause) => mapPeerCallError(peer.peerId)(cause)),
        Effect.tap(() => peers.setPeerStatus(peer.peerId, { status: "online", lastError: null })),
      );
    });

  const isAuthRejection = (cause: unknown): boolean =>
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause as { _tag: unknown })._tag === "EnvironmentAuthInvalidError";

  const requireAllowed = (
    peer: FederationPeerStore.PersistedFederationPeer,
    scopes: ReadonlyArray<FederationScope>,
  ) =>
    scopesIncludeAll(peer.allowedScopes, scopes)
      ? Effect.void
      : Effect.fail(
          new FederationError({
            code: "scope-denied",
            message: `${peer.label} has not granted this environment ${scopes.join(", ")}.`,
          }),
        );

  const requireLocalPeer = (peerId: EnvironmentId) =>
    peers.getPeer(peerId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new FederationError({
                code: "peer-unknown",
                message: "That environment is not paired here.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const refreshPeer: FederationService["Service"]["refreshPeer"] = Effect.fn(
    "FederationService.refreshPeer",
  )(function* (peerId) {
    const peer = yield* requireLocalPeer(peerId);
    const hello = yield* callPeer(peer, (client, headers) =>
      client.federation.hello({ headers }),
    ).pipe(Effect.result);
    if (Result.isFailure(hello)) {
      yield* publishPeers;
      const presented = yield* peers.presentPeer(peer);
      return presented;
    }
    const at = yield* nowIso;
    const updated = {
      ...peer,
      label: hello.success.label,
      remoteServerVersion: hello.success.serverVersion,
      remoteProtocolVersion: hello.success.protocolVersion,
      remoteCapabilities: hello.success.capabilities,
      lastSeenAt: at,
    };
    yield* peers.upsertPeer(updated).pipe(Effect.mapError(storeError));
    yield* publishPeers;
    return yield* peers.presentPeer(updated);
  });

  const createPeerCode: FederationService["Service"]["createPeerCode"] = Effect.fn(
    "FederationService.createPeerCode",
  )(function* (input) {
    const endpoint = yield* tailcat.readyEndpoint;
    if (Option.isNone(endpoint)) {
      return yield* new FederationError({
        code: "transport-unavailable",
        message: "Enable Tailcat access on this environment before pairing peers.",
      });
    }
    if (input.scopes.length === 0) {
      return yield* new FederationError({
        code: "scope-denied",
        message: "Grant the peer at least one capability.",
      });
    }
    const ttlSeconds = input.ttlSeconds ?? FEDERATION_PEER_CODE_DEFAULT_TTL_SECONDS;
    const issued = yield* environmentAuth
      .createPairingLink({
        scopes: [AuthFederationPeerScope],
        subject: FEDERATION_PEER_CODE_PAIRING_SUBJECT,
        label: "Federation peer code",
        ttl: Duration.seconds(ttlSeconds),
      })
      .pipe(Effect.mapError((error) => internalError(error.message)));
    yield* Ref.update(pendingPeerCodes, (current) => new Map(current).set(issued.id, input.scopes));
    const descriptor = yield* serverEnvironment.getDescriptor;
    const expiresAt = DateTime.formatIso(issued.expiresAt);
    const payload = {
      v: 1 as const,
      kind: "peer" as const,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      environmentId: identity.environmentId,
      publicKey: identity.publicKey,
      label: descriptor.label,
      transport: { tailcat: { address: endpoint.value.address, port: endpoint.value.port } },
      token: issued.credential,
      scopes: input.scopes,
      expiresAt,
    };
    yield* Effect.logInfo("Federation peer code issued.", {
      pairingLinkId: issued.id,
      scopes: input.scopes,
      expiresAt,
    });
    return {
      code: encodeFederationPeerCode(payload),
      payload,
      expiresAt,
    } satisfies FederationPeerCodeResult;
  });

  const addPeer: FederationService["Service"]["addPeer"] = Effect.fn("FederationService.addPeer")(
    function* (input) {
      const payload = yield* Effect.try({
        try: () => decodeFederationPeerCode(input.code),
        catch: (cause) =>
          new FederationError({
            code: "code-invalid",
            message: isConnectionCodeInvalidError(cause)
              ? cause.message
              : "The peer code is invalid.",
          }),
      });
      if (payload.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
        return yield* new FederationError({
          code: "protocol-incompatible",
          message: `The peer speaks federation protocol v${payload.protocolVersion}; this environment speaks v${FEDERATION_PROTOCOL_VERSION}. Update the older side.`,
        });
      }
      if (payload.environmentId === identity.environmentId) {
        return yield* new FederationError({
          code: "code-invalid",
          message: "This is this environment's own peer code. Paste it on the other machine.",
        });
      }
      if (DateTime.toEpochMillis(DateTime.makeUnsafe(payload.expiresAt)) <= (yield* nowMs)) {
        return yield* new FederationError({
          code: "code-expired",
          message: "This peer code has expired. Create a new one on the other machine.",
        });
      }
      const endpoint = yield* transport.endpointFor({
        peerId: payload.environmentId,
        transport: payload.transport,
      });
      const client = yield* clientFor(endpoint.httpBaseUrl).pipe(
        Effect.mapError((cause) => internalError(describeCause(cause))),
      );
      const descriptor = yield* serverEnvironment.getDescriptor;
      const ourNodeKey = yield* transport.clientNodeKey.pipe(Effect.option);
      const response = yield* client.federation
        .pair({
          payload: {
            token: payload.token,
            protocolVersion: FEDERATION_PROTOCOL_VERSION,
            environmentId: identity.environmentId,
            publicKey: identity.publicKey,
            label: descriptor.label,
            serverVersion: descriptor.serverVersion,
            capabilities: FEDERATION_CAPABILITIES,
            transport: yield* ourTransport,
            grantedScopes: input.grantedScopes,
            ...(Option.isSome(ourNodeKey) ? { tailcatNodeKey: ourNodeKey.value } : {}),
          },
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: PEER_REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new FederationError({
                  code: "peer-unreachable",
                  message: "The other machine did not answer the pairing request in time.",
                }),
              ),
          }),
          Effect.mapError((cause) =>
            isFederationError(cause)
              ? cause
              : new FederationError({
                  code: "peer-unreachable",
                  message: `Pairing failed: ${describeCause(cause)}`,
                }),
          ),
        );
      if (
        response.environmentId !== payload.environmentId ||
        response.publicKey !== payload.publicKey
      ) {
        yield* transport.drop(payload.environmentId);
        return yield* new FederationError({
          code: "peer-rejected",
          message:
            "The machine behind this code identified itself differently than the code claims. Pairing was aborted.",
        });
      }
      const at = yield* nowIso;
      const stored: FederationPeerStore.PersistedFederationPeer = {
        peerId: response.environmentId,
        label: response.label,
        publicKey: response.publicKey,
        grantedScopes: input.grantedScopes,
        allowedScopes: response.grantedScopes,
        transport: payload.transport,
        remoteServerVersion: response.serverVersion,
        remoteProtocolVersion: response.protocolVersion,
        remoteCapabilities: response.capabilities,
        createdAt: at,
        lastSeenAt: at,
      };
      yield* peers.upsertPeer(stored).pipe(Effect.mapError(storeError));
      yield* peers.setPeerStatus(stored.peerId, { status: "online", lastError: null });
      if (response.tailcatNodeKey !== undefined) {
        yield* tailcat
          .recordTrustedPeer({
            nodeKey: response.tailcatNodeKey,
            label: `Federation: ${response.label}`,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not trust the peer's Tailcat key.", { error }),
            ),
          );
      }
      yield* Effect.logInfo("Paired with a federation peer.", {
        peerId: stored.peerId,
        allowedScopes: stored.allowedScopes,
        grantedScopes: stored.grantedScopes,
      });
      yield* publishPeers;
      return yield* peers.presentPeer(stored);
    },
  );

  const removePeer: FederationService["Service"]["removePeer"] = Effect.fn(
    "FederationService.removePeer",
  )(function* (peerId) {
    const peer = yield* requireLocalPeer(peerId);
    yield* peers.removePeer(peerId).pipe(Effect.mapError(storeError));
    yield* Ref.update(peerSessions, (current) => {
      const next = new Map(current);
      next.delete(peerId);
      return next;
    });
    yield* transport.drop(peerId);
    // Sessions the peer holds here die with the trust relationship.
    const sessions = yield* environmentAuth.listSessions().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      sessions.filter(
        (session) => session.subject === `${FEDERATION_SESSION_SUBJECT_PREFIX}${peerId}`,
      ),
      (session) => environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Effect.logInfo("Federation peer removed.", { peerId, label: peer.label });
    yield* publishPeers;
    yield* publishRuns;
  });

  const listRemoteProjects: FederationService["Service"]["listRemoteProjects"] = Effect.fn(
    "FederationService.listRemoteProjects",
  )(function* (peerId) {
    const peer = yield* requireLocalPeer(peerId);
    yield* requireAllowed(peer, ["projects.read"]);
    return yield* callPeer(peer, (client, headers) => client.federation.projects({ headers }));
  });

  const upsertRemoteRun = (record: FederationRemoteRun) =>
    peers.upsertRemoteRun(record).pipe(Effect.mapError(storeError), Effect.andThen(publishRuns));

  const startRemoteRun: FederationService["Service"]["startRemoteRun"] = Effect.fn(
    "FederationService.startRemoteRun",
  )(function* (input) {
    const peer = yield* requireLocalPeer(input.peerId);
    yield* requireAllowed(peer, ["runs.start", "runs.read"]);
    const run = yield* callPeer(peer, (client, headers) =>
      client.federation.startRun({
        headers,
        payload: {
          projectId: input.projectId,
          prompt: input.prompt,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        },
      }),
    );
    const record: FederationRemoteRun = {
      peerId: peer.peerId,
      peerLabel: peer.label,
      run,
      events: [],
      lastSyncedAt: yield* nowIso,
      syncError: null,
    };
    yield* upsertRemoteRun(record);
    yield* Queue.offer(pollSignals, "poll");
    return record;
  });

  const findRemoteRun = (input: FederationRemoteRunInput) =>
    peers.remoteRuns.pipe(
      Effect.flatMap((runs) => {
        const record = runs.find(
          (run) => run.peerId === input.peerId && run.run.threadId === input.threadId,
        );
        return record === undefined
          ? Effect.fail(
              new FederationError({
                code: "run-not-found",
                message: "That remote run is not tracked here.",
              }),
            )
          : Effect.succeed(record);
      }),
    );

  const cancelRemoteRun: FederationService["Service"]["cancelRemoteRun"] = Effect.fn(
    "FederationService.cancelRemoteRun",
  )(function* (input) {
    const peer = yield* requireLocalPeer(input.peerId);
    yield* requireAllowed(peer, ["runs.cancel"]);
    const record = yield* findRemoteRun(input);
    const run = yield* callPeer(peer, (client, headers) =>
      client.federation.cancelRun({ headers, params: { threadId: input.threadId } }),
    );
    const updated = { ...record, run, lastSyncedAt: yield* nowIso, syncError: null };
    yield* upsertRemoteRun(updated);
    return updated;
  });

  const describeRemoteArtifacts: FederationService["Service"]["describeRemoteArtifacts"] =
    Effect.fn("FederationService.describeRemoteArtifacts")(function* (input) {
      const peer = yield* requireLocalPeer(input.peerId);
      yield* requireAllowed(peer, ["artifacts.read"]);
      yield* findRemoteRun(input);
      return yield* callPeer(peer, (client, headers) =>
        client.federation.runArtifacts({ headers, params: { threadId: input.threadId } }),
      );
    });

  const fetchRemoteArtifact: FederationService["Service"]["fetchRemoteArtifact"] = Effect.fn(
    "FederationService.fetchRemoteArtifact",
  )(function* (input) {
    const peer = yield* requireLocalPeer(input.peerId);
    yield* requireAllowed(peer, ["artifacts.read"]);
    yield* findRemoteRun({ peerId: input.peerId, threadId: input.threadId });
    return yield* callPeer(peer, (client, headers) =>
      client.federation.fetchArtifact({
        headers,
        params: { threadId: input.threadId, turnId: input.turnId },
      }),
    );
  });

  const syncRemoteRun = (record: FederationRemoteRun) =>
    Effect.gen(function* () {
      const peer = yield* peers.getPeer(record.peerId);
      if (Option.isNone(peer)) {
        return;
      }
      const afterSequence = record.events.at(-1)?.sequence ?? 0;
      const response = yield* callPeer(peer.value, (client, headers) =>
        client.federation.runEvents({
          headers,
          params: { threadId: record.run.threadId },
          payload: { afterSequence },
        }),
      ).pipe(Effect.result);
      const at = yield* nowIso;
      if (Result.isFailure(response)) {
        yield* upsertRemoteRun({
          ...record,
          lastSyncedAt: at,
          syncError: response.failure.message,
        });
        return;
      }
      const merged = [...record.events, ...response.success.events].slice(-REMOTE_RUN_EVENT_LIMIT);
      yield* upsertRemoteRun({
        ...record,
        run: response.success.run,
        events: merged,
        lastSyncedAt: at,
        syncError: null,
      });
    });

  const pollLoop = Effect.gen(function* () {
    for (;;) {
      const runs = yield* peers.remoteRuns;
      const active = runs.filter((record) => isFederationRunActive(record.run));
      if (active.length === 0) {
        // Nothing to watch: sleep until a run starts instead of polling peers for nothing.
        yield* Queue.take(pollSignals);
        yield* Queue.clear(pollSignals);
        continue;
      }
      yield* Effect.forEach(active, syncRemoteRun, { discard: true, concurrency: 2 });
      yield* Effect.raceFirst(
        Effect.sleep(REMOTE_RUN_POLL_INTERVAL),
        Queue.take(pollSignals).pipe(Effect.asVoid),
      );
    }
  });
  yield* pollLoop.pipe(Effect.forkIn(serviceScope));

  const refreshAllPeers = peers.peers.pipe(
    Effect.flatMap((stored) =>
      Effect.forEach(stored, (peer) => refreshPeer(peer.peerId).pipe(Effect.ignore), {
        discard: true,
        concurrency: 2,
      }),
    ),
  );
  yield* Effect.sleep(Duration.seconds(15)).pipe(
    Effect.andThen(refreshAllPeers),
    Effect.andThen(
      Effect.sleep(PEER_REFRESH_INTERVAL).pipe(Effect.andThen(refreshAllPeers), Effect.forever),
    ),
    Effect.forkIn(serviceScope),
  );

  return FederationService.of({
    snapshot: SubscriptionRef.get(snapshotRef),
    changes: SubscriptionRef.changes(snapshotRef),
    remoteRuns: SubscriptionRef.get(runsRef),
    remoteRunChanges: SubscriptionRef.changes(runsRef),
    createPeerCode,
    addPeer,
    removePeer,
    refreshPeer,
    listRemoteProjects,
    startRemoteRun,
    cancelRemoteRun,
    describeRemoteArtifacts,
    fetchRemoteArtifact,
    acceptPair,
    issueChallenge,
    redeemChallenge,
    authorizePeer,
    hello: helloEffect,
    localProjects,
    startLocalRun,
    localRunStatus,
    cancelLocalRun,
    localRunEvents,
    localRunArtifacts,
    fetchLocalArtifact,
  });
});

export const layer = Layer.effect(FederationService, make);
