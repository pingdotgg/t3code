import {
  CommandId,
  EventId,
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES,
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES,
  OrchestrationV2HandoffBundleV1,
  OrchestrationV2HandoffError,
  ProjectId,
  ThreadHandoffId,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2HandoffPart,
  type OrchestrationV2HandoffPartKind,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type VcsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { PlatformError } from "effect/PlatformError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { toSafeThreadId as terminalHistoryFilePrefix } from "../terminal/Manager.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import {
  classifyIncomingTip,
  handoffPreTagName,
  handoffRefName,
  handoffStashLabel,
  ThreadHandoffGit,
  type HandoffTipClassification,
} from "./ThreadHandoffGit.ts";

const HANDOFF_EVENT_PREFIX = "handoff";

/** File a part is staged under. Derived from the kind so both sides agree without negotiating. */
export function partFileName(kind: OrchestrationV2HandoffPartKind): string {
  switch (kind) {
    case "git-bundle":
      return "objects.bundle";
    case "tracked-patch":
      return "tracked.patch";
    case "untracked-tar":
      return "untracked.tar.gz";
    case "attachments-tar":
      return "attachments.tar.gz";
    case "terminals-tar":
      return "terminals.tar.gz";
  }
}

export function sha256(contents: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

/**
 * Total payload size against the two ceilings.
 *
 * Both are checked while preparing, before anything has been sent, so a
 * refusal costs nothing on either machine and the warning has somewhere useful
 * to appear.
 */
export type HandoffPayloadVerdict = "ok" | "warn" | "refuse";

export function classifyPayloadSize(totalBytes: number): HandoffPayloadVerdict {
  if (totalBytes > ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES) return "refuse";
  if (totalBytes > ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES) return "warn";
  return "ok";
}

/**
 * The conversation this hop carries.
 *
 * Every item goes, along with the run ordinals they cover, which is the same
 * pairing `ContextHandoffService` already uses to describe what a receiving
 * provider session has and has not seen.
 */
export function conversationPayload(projection: OrchestrationV2ThreadProjection): {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly coveredRunOrdinals: ReadonlyArray<number>;
} {
  return {
    items: projection.turnItems,
    coveredRunOrdinals: projection.runs.map((_, index) => index + 1),
  };
}

/**
 * The window of a staged part a read should return.
 *
 * Clamping the offset rather than rejecting a stale one keeps a resumed
 * transfer from failing on a retry that asks for bytes past the end, and
 * `complete` is what tells the caller to stop asking rather than making it
 * compare offsets itself.
 */
export function handoffChunkWindow(input: {
  readonly totalBytes: number;
  readonly offset: number;
  readonly chunkBytes: number;
}): { readonly offset: number; readonly end: number; readonly complete: boolean } {
  const offset = Math.max(0, Math.min(input.offset, input.totalBytes));
  const end = Math.min(offset + input.chunkBytes, input.totalBytes);
  return { offset, end, complete: end >= input.totalBytes };
}

/**
 * Rewrites one carried turn item into this environment's history.
 *
 * The origin's run, node and provider references do not exist here, so they
 * are dropped rather than left dangling; the item id and ordinal survive,
 * which is what keeps the conversation ordered and makes a later return trip
 * deduplicable instead of doubling every message.
 */
function localizeTurnItem(
  item: OrchestrationV2TurnItem,
  threadId: ThreadId,
): OrchestrationV2TurnItem {
  return {
    ...item,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
  } as OrchestrationV2TurnItem;
}

export interface ThreadHandoffPreparation {
  readonly bundle: OrchestrationV2HandoffBundleV1;
  readonly totalBytes: number;
  readonly verdict: HandoffPayloadVerdict;
  readonly dirtyFileCount: number;
  readonly untrackedFileCount: number;
}

export interface ThreadHandoffApplication {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly classification: HandoffTipClassification;
  readonly stashRef: string | null;
  readonly preTag: string | null;
}

export class ThreadHandoffService extends Context.Service<
  ThreadHandoffService,
  {
    /**
     * Reads the thread and its worktree and stages the parts. Writes nothing the
     * user can see and does not lock the thread, so the preflight a user
     * approves comes from the same code path the transfer itself uses.
     */
    readonly prepare: (input: {
      readonly threadId: ThreadId;
      readonly peerEnvironmentId: EnvironmentId;
      /** The destination's current tip for this branch, so the bundle carries only what it lacks. */
      readonly peerBranchTip: string | null;
      /** Bundle the whole history so the destination can clone with no remote. */
      readonly fullHistory: boolean;
      readonly previousHandoffId: ThreadHandoffId | null;
      readonly hopCount: number;
    }) => Effect.Effect<ThreadHandoffPreparation, OrchestrationV2HandoffError>;
    /** Absolute path a part is staged at, for the transport to read from or write to. */
    readonly partPath: (input: {
      readonly handoffId: ThreadHandoffId;
      readonly kind: OrchestrationV2HandoffPartKind;
    }) => string;
    readonly verifyStagedPart: (input: {
      readonly handoffId: ThreadHandoffId;
      readonly part: OrchestrationV2HandoffPart;
    }) => Effect.Effect<void, OrchestrationV2HandoffError>;
    /**
     * Applies a staged bundle, creating the thread or — when the hop returns to
     * a thread this environment already owns — continuing it.
     */
    readonly receive: (input: {
      readonly bundle: OrchestrationV2HandoffBundleV1;
      /** Null when the repository must first be cloned from the bundle. */
      readonly projectId: ProjectId | null;
      readonly cloneWorkspaceRoot: string | null;
      readonly returningThreadId: ThreadId | null;
    }) => Effect.Effect<ThreadHandoffApplication, OrchestrationV2HandoffError>;
    /**
     * Fails hops that were still applying when the server stopped. That is the
     * only state in which a repository can have been written to, so it is the
     * only state that needs recovering.
     */
    readonly recoverInterrupted: () => Effect.Effect<number>;
  }
>()("t3/orchestration-v2/ThreadHandoffService") {}

const isHandoffError = Schema.is(OrchestrationV2HandoffError);

/**
 * Turns a dependency's failure into a handoff failure, leaving one that is
 * already a handoff failure alone so the specific reason a step chose is not
 * flattened into the generic one of its caller.
 */
const asHandoffError = (reason: OrchestrationV2HandoffError["reason"], detail: string) =>
  Effect.mapError(
    (cause: unknown): OrchestrationV2HandoffError =>
      isHandoffError(cause) ? cause : new OrchestrationV2HandoffError({ reason, detail, cause }),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const eventSink = yield* EventSinkV2;
  const projectionStore = yield* ProjectionStoreV2;
  const git = yield* ThreadHandoffGit;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentity = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2HandoffBundleV1));
  const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2HandoffBundleV1));

  // One hop at a time per thread: prepare reads a working tree a receive may be
  // rewriting, and two concurrent hops would each believe they own the thread.
  const serialize = yield* makeKeyedSerialExecutor<string>();

  const handoffDir = (handoffId: ThreadHandoffId) => path.join(config.handoffsDir, handoffId);

  const partPath: ThreadHandoffService["Service"]["partPath"] = (input) =>
    path.join(handoffDir(input.handoffId), partFileName(input.kind));

  // Digest and size read in chunks: a part can be close to the gigabyte
  // ceiling, and reading one whole into a buffer to hash it is how the
  // process runs out of heap before the ceiling is ever checked.
  const measurePart = (target: string) =>
    Effect.gen(function* () {
      const hash = NodeCrypto.createHash("sha256");
      let byteLength = 0;
      yield* Stream.runForEach(fs.stream(target), (chunk: Uint8Array) =>
        Effect.sync(() => {
          hash.update(chunk);
          byteLength += chunk.length;
        }),
      );
      return { digest: hash.digest("hex"), byteLength };
    });

  const stagePart = (input: {
    readonly handoffId: ThreadHandoffId;
    readonly kind: OrchestrationV2HandoffPartKind;
    readonly write: (targetPath: string) => Effect.Effect<void, PlatformError | VcsError>;
  }) =>
    Effect.gen(function* () {
      const target = partPath({ handoffId: input.handoffId, kind: input.kind });
      yield* fs.makeDirectory(handoffDir(input.handoffId), { recursive: true });
      yield* input.write(target);
      const exists = yield* fs.exists(target);
      if (!exists) return null;
      const measured = yield* measurePart(target);
      // An empty part is the absence of a payload, not a payload of zero bytes:
      // dropping it keeps the manifest an accurate list of what has to move.
      if (measured.byteLength === 0) {
        yield* fs.remove(target).pipe(Effect.ignore);
        return null;
      }
      return {
        kind: input.kind,
        digest: measured.digest,
        byteLength: measured.byteLength,
      } satisfies OrchestrationV2HandoffPart;
    }).pipe(asHandoffError("store_failed", `Could not stage the ${input.kind} part.`));

  const verifyStagedPart: ThreadHandoffService["Service"]["verifyStagedPart"] = (input) =>
    Effect.gen(function* () {
      const target = partPath({ handoffId: input.handoffId, kind: input.part.kind });
      const exists = yield* fs
        .exists(target)
        .pipe(asHandoffError("store_failed", "Could not read a staged handoff part."));
      if (!exists) {
        return yield* new OrchestrationV2HandoffError({
          reason: "part_missing",
          detail: `Handoff part ${input.part.kind} was never uploaded.`,
          handoffId: input.handoffId,
        });
      }
      const measured = yield* measurePart(target).pipe(
        asHandoffError("store_failed", "Could not read a staged handoff part."),
      );
      // The declared length is what size accounting downstream trusts, so a
      // manifest that understates it is rejected the same way a wrong digest is.
      if (measured.byteLength !== input.part.byteLength) {
        return yield* new OrchestrationV2HandoffError({
          reason: "part_digest_mismatch",
          detail: `Handoff part ${input.part.kind} is ${measured.byteLength} bytes, not the ${input.part.byteLength} bytes the manifest declares.`,
          handoffId: input.handoffId,
        });
      }
      if (measured.digest !== input.part.digest) {
        return yield* new OrchestrationV2HandoffError({
          reason: "part_digest_mismatch",
          detail: `Handoff part ${input.part.kind} does not match the digest in the manifest.`,
          handoffId: input.handoffId,
        });
      }
    });

  const recordHop = (input: {
    readonly handoffId: ThreadHandoffId;
    readonly threadId: ThreadId;
    readonly peerEnvironmentId: EnvironmentId;
    readonly peerThreadId: ThreadId | null;
    readonly previousHandoffId: ThreadHandoffId | null;
    readonly hopCount: number;
    readonly state: string;
    readonly bundle: OrchestrationV2HandoffBundleV1;
  }) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const manifestJson = yield* encodeManifest(input.bundle);
      yield* sql`
        INSERT INTO orchestration_v2_thread_handoffs (
          handoff_id,
          thread_id,
          peer_environment_id,
          peer_thread_id,
          previous_handoff_id,
          hop_count,
          state,
          manifest_json,
          created_at,
          updated_at
        ) VALUES (
          ${input.handoffId},
          ${input.threadId},
          ${input.peerEnvironmentId},
          ${input.peerThreadId},
          ${input.previousHandoffId},
          ${input.hopCount},
          ${input.state},
          ${manifestJson},
          ${now},
          ${now}
        )
        ON CONFLICT(handoff_id) DO UPDATE SET
          state = excluded.state,
          peer_thread_id = excluded.peer_thread_id,
          manifest_json = excluded.manifest_json,
          -- A retry reuses the row, and the previous attempt's rollback
          -- metadata describes a checkout this attempt has not touched:
          -- inheriting it would have recovery reset or pop the wrong tree.
          -- The arrival of the same attempt keeps them: the stash refs must
          -- survive until the post-arrival pops have actually run.
          applied_head_sha = CASE WHEN excluded.state = 'arrived' THEN applied_head_sha ELSE NULL END,
          stash_ref = CASE WHEN excluded.state = 'arrived' THEN stash_ref ELSE NULL END,
          root_stash_ref = CASE WHEN excluded.state = 'arrived' THEN root_stash_ref ELSE NULL END,
          pre_tag = CASE WHEN excluded.state = 'arrived' THEN pre_tag ELSE NULL END,
          created_worktree = CASE WHEN excluded.state = 'arrived' THEN created_worktree ELSE 0 END,
          apply_cwd = NULL,
          root_cwd = NULL,
          updated_at = excluded.updated_at
      `;
    }).pipe(asHandoffError("store_failed", "Could not record the handoff."));

  const markHop = (input: {
    readonly handoffId: ThreadHandoffId;
    readonly state: string;
    readonly lastError: string | null;
    readonly appliedHeadSha?: string | null;
    readonly stashRef?: string | null;
    readonly rootStashRef?: string | null;
    readonly preTag?: string | null;
    readonly applyCwd?: string | null;
    readonly rootCwd?: string | null;
    readonly createdWorktree?: boolean;
  }) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE orchestration_v2_thread_handoffs
        SET
          state = ${input.state},
          last_error = ${input.lastError},
          applied_head_sha = COALESCE(${input.appliedHeadSha ?? null}, applied_head_sha),
          stash_ref = COALESCE(${input.stashRef ?? null}, stash_ref),
          root_stash_ref = COALESCE(${input.rootStashRef ?? null}, root_stash_ref),
          pre_tag = COALESCE(${input.preTag ?? null}, pre_tag),
          apply_cwd = COALESCE(${input.applyCwd ?? null}, apply_cwd),
          root_cwd = COALESCE(${input.rootCwd ?? null}, root_cwd),
          created_worktree = COALESCE(${input.createdWorktree === undefined ? null : input.createdWorktree ? 1 : 0}, created_worktree),
          updated_at = ${now}
        WHERE handoff_id = ${input.handoffId}
      `;
    }).pipe(asHandoffError("store_failed", "Could not update the handoff."));

  const workspaceRootFor = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asHandoffError("project_missing", `Project ${projectId} could not be read.`),
      Effect.flatMap((project) =>
        Option.isNone(project)
          ? new OrchestrationV2HandoffError({
              reason: "project_missing",
              detail: `Project ${projectId} is not on this environment.`,
            })
          : Effect.succeed(project.value.workspaceRoot),
      ),
    );

  const repositoryIdentityFor = (cwd: string) =>
    repositoryIdentity.resolve(cwd).pipe(
      Effect.flatMap((identity) =>
        identity === null
          ? new OrchestrationV2HandoffError({
              reason: "repository_mismatch",
              detail:
                "This thread's workspace has no git remote, so the other machine cannot recognise the repository.",
            })
          : Effect.succeed(identity),
      ),
    );

  const driverKindFor = (thread: OrchestrationV2AppThread) =>
    providerAdapters.get(thread.providerInstanceId).pipe(
      Effect.map((adapter) => adapter.driver),
      asHandoffError(
        "environment_unsupported",
        `Provider ${thread.providerInstanceId} is not configured here.`,
      ),
    );

  const threadCwd = (thread: OrchestrationV2AppThread) =>
    thread.worktreePath === null
      ? workspaceRootFor(thread.projectId)
      : Effect.succeed(thread.worktreePath);

  const prepare: ThreadHandoffService["Service"]["prepare"] = (input) => {
    // Staging writes parts to disk before the manifest exists. A failure
    // anywhere after the first part — oversized payload, a git error, the
    // hop row not recording — would otherwise leave them there with nothing
    // left that knows their id.
    let stagedHandoffId: ThreadHandoffId | null = null;
    return serialize.withLock(
      input.threadId,
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(input.threadId)
          .pipe(asHandoffError("thread_missing", `Thread ${input.threadId} could not be read.`));
        const thread = projection.thread;
        // Only an away thread refuses: a thread that arrived here is live and
        // free to move again — onward, or back where it came from.
        if (thread.handoff?.presence === "away") {
          return yield* new OrchestrationV2HandoffError({
            reason: "thread_already_away",
            detail: `Thread ${input.threadId} is already handed off.`,
          });
        }
        // A running agent is writing the worktree this hop is about to
        // snapshot; a bundle cut mid-write would carry a half-finished state
        // to the other machine. Refuse with the action the user can take.
        const busy = projection.runs.some((run) =>
          ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
        );
        if (busy) {
          return yield* new OrchestrationV2HandoffError({
            reason: "thread_busy",
            detail:
              "The agent is still working in this thread. Interrupt it or let it finish, then send.",
          });
        }

        const cwd = yield* threadCwd(thread);
        const handoffId = ThreadHandoffId.make(NodeCrypto.randomUUID());
        stagedHandoffId = handoffId;
        const branch = thread.branch;
        const headSha = yield* git
          .resolveHead({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not read the thread's HEAD."));
        // Checkpoint refs are hidden git refs, so bundling them alongside the
        // commits carries the whole checkpoint timeline with no payload of its
        // own, and revert keeps working on the far side.
        const checkpointRefs = yield* git
          .listCheckpointRefs({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not list checkpoint refs."));
        const patch = yield* git
          .trackedPatch({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not read the thread's tracked changes."));
        const untracked = yield* git
          .untrackedPaths({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not list untracked files."));
        const dirtyFileCount = yield* git
          .dirtyFileCount({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not count changed files."));

        const parts: Array<OrchestrationV2HandoffPart> = [];
        const bundlePart = yield* stagePart({
          handoffId,
          kind: "git-bundle",
          write: (target) =>
            git.createBundle({
              cwd,
              outputPath: target,
              refs: [...(branch === null ? ["HEAD"] : [`refs/heads/${branch}`]), ...checkpointRefs],
              // With no known peer tip, cut against this repository's
              // remote-tracking refs: both sides clone the same remote, so
              // anything a remote already has is not worth shipping. Without
              // this a first hop bundles the repository's entire history.
              excludeTips: input.fullHistory
                ? []
                : input.peerBranchTip === null
                  ? ["--remotes"]
                  : [input.peerBranchTip],
            }),
        });
        if (bundlePart !== null) parts.push(bundlePart);

        const patchPart = yield* stagePart({
          handoffId,
          kind: "tracked-patch",
          write: (target) => fs.writeFileString(target, patch),
        });
        if (patchPart !== null) parts.push(patchPart);

        if (untracked.length > 0) {
          const untrackedPart = yield* stagePart({
            handoffId,
            kind: "untracked-tar",
            write: (target) => git.archivePaths({ cwd, paths: untracked, outputPath: target }),
          });
          if (untrackedPart !== null) parts.push(untrackedPart);
        }

        // Attachments are flat files named by a thread-derived prefix. They
        // travel under their original names, which is what the carried turn
        // items reference, so nothing has to be rewritten on arrival.
        const threadSegment = toSafeThreadAttachmentSegment(thread.id);
        // A missing directory means no thread ever attached anything; an
        // unreadable one must stop the hop, or the carried turn items would
        // reference attachments that silently never travelled.
        const attachmentFiles =
          threadSegment === null ||
          !(yield* fs.exists(config.attachmentsDir).pipe(Effect.orElseSucceed(() => false)))
            ? []
            : yield* fs.readDirectory(config.attachmentsDir).pipe(
                Effect.map((entries) =>
                  entries.filter((entry) => entry.startsWith(`${threadSegment}-`)),
                ),
                asHandoffError("store_failed", "Could not read the attachments directory."),
              );
        if (attachmentFiles.length > 0) {
          const attachmentsPart = yield* stagePart({
            handoffId,
            kind: "attachments-tar",
            write: (target) =>
              git.archivePaths({
                cwd: config.attachmentsDir,
                paths: attachmentFiles,
                outputPath: target,
              }),
          });
          if (attachmentsPart !== null) parts.push(attachmentsPart);
        }

        // Terminal scrollback lives as flat history files named by a
        // thread-derived prefix. The PTY itself cannot travel; the history the
        // user reads can, and the manager restores a session from it on first
        // open exactly as it does after a restart.
        const terminalPrefix = terminalHistoryFilePrefix(thread.id);
        const terminalFiles = yield* fs.readDirectory(config.terminalLogsDir).pipe(
          Effect.map((entries) =>
            entries.filter(
              (entry) =>
                entry === `${terminalPrefix}.log` || entry.startsWith(`${terminalPrefix}_`),
            ),
          ),
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        );
        if (terminalFiles.length > 0) {
          const terminalsPart = yield* stagePart({
            handoffId,
            kind: "terminals-tar",
            write: (target) =>
              git.archivePaths({
                cwd: config.terminalLogsDir,
                paths: terminalFiles,
                outputPath: target,
              }),
          });
          if (terminalsPart !== null) parts.push(terminalsPart);
        }

        const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
        const verdict = classifyPayloadSize(totalBytes);
        if (verdict === "refuse") {
          return yield* new OrchestrationV2HandoffError({
            reason: "payload_too_large",
            detail: `This thread's working state is ${Math.round(
              totalBytes / (1024 * 1024),
            )} MB, over the ${Math.round(
              ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES / (1024 * 1024),
            )} MB limit. Ignore or clean build output and try again.`,
            handoffId,
          });
        }

        const environmentId = yield* environment.getEnvironmentId;
        const descriptor = yield* environment.getDescriptor;
        const bundle: OrchestrationV2HandoffBundleV1 = {
          version: 1,
          handoffId,
          origin: {
            environmentId,
            threadId: thread.id,
            serverVersion: descriptor.serverVersion,
            label: descriptor.label,
          },
          repository: yield* repositoryIdentityFor(cwd),
          workspace: {
            branch,
            headSha,
            strategy:
              thread.worktreePath === null
                ? { type: "root", ...(branch === null ? {} : { branch }) }
                : {
                    type: "existing_worktree",
                    worktreePath: thread.worktreePath,
                    ...(branch === null ? {} : { branch }),
                  },
          },
          conversation: conversationPayload(projection),
          provider: {
            driverKind: yield* driverKindFor(thread),
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          },
          thread: { title: thread.title },
          terminals: [],
          lineage: {
            previousHandoffId: input.previousHandoffId,
            hopCount: input.hopCount,
          },
          parts,
        };

        yield* recordHop({
          handoffId,
          threadId: thread.id,
          peerEnvironmentId: input.peerEnvironmentId,
          peerThreadId: null,
          previousHandoffId: input.previousHandoffId,
          hopCount: input.hopCount,
          state: "preparing",
          bundle,
        });

        return {
          bundle,
          totalBytes,
          verdict,
          dirtyFileCount,
          untrackedFileCount: untracked.length,
        } satisfies ThreadHandoffPreparation;
      }).pipe(
        Effect.onError(() =>
          stagedHandoffId === null
            ? Effect.void
            : fs.remove(handoffDir(stagedHandoffId), { recursive: true }).pipe(Effect.ignore),
        ),
      ),
    );
  };

  const rollback = (input: {
    readonly cwd: string;
    readonly preTag: string | null;
    readonly stashRef: string | null;
  }) =>
    Effect.gen(function* () {
      if (input.preTag !== null) {
        yield* git.resetHardTo({ cwd: input.cwd, commit: input.preTag }).pipe(Effect.ignore);
      }
      if (input.stashRef !== null) {
        yield* git.popStash({ cwd: input.cwd, stashRef: input.stashRef }).pipe(Effect.ignore);
      }
    });

  /**
   * Replays the carried conversation as this environment's own history. A
   * returning hop continues the thread that is already here; a first arrival
   * creates one. Either way the handoff link is what marks this side live.
   */
  const writeArrival = (input: {
    readonly bundle: OrchestrationV2HandoffBundleV1;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly existing: OrchestrationV2AppThread | null;
    readonly existingItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly worktreePath: string | null;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { bundle } = input;
      const base: OrchestrationV2AppThread = input.existing ?? {
        id: input.threadId,
        projectId: input.projectId,
        title: bundle.thread.title,
        providerInstanceId: bundle.provider.modelSelection.instanceId,
        modelSelection: bundle.provider.modelSelection,
        runtimeMode: bundle.provider.runtimeMode,
        interactionMode: bundle.provider.interactionMode,
        branch: bundle.workspace.branch,
        worktreePath: input.worktreePath,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: input.threadId,
        },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "server",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const returning = input.existing !== null;
      const thread: OrchestrationV2AppThread = {
        ...base,
        // A provisioned worktree wins even for a returning thread: the
        // incoming changes were applied there, so that is where work resumes.
        worktreePath: input.worktreePath ?? base.worktreePath,
        // The carried title wins: a rename made on either side reaches the
        // pair at the next hop instead of leaving a stale name behind.
        title: bundle.thread.title,
        // Arrival revives: a copy the user archived (or one archived by an
        // older build) returns to the sidebar the moment work lands in it.
        archivedAt: returning ? null : base.archivedAt,
        // Every arrival keeps a "here" link — it is provenance, not a lock.
        // Only "away" restricts anything, so keeping the link through round
        // trips is what preserves "moved from X" and the pull-back verbs
        // after any number of hops.
        handoff: {
          handoffId: bundle.handoffId,
          presence: "here",
          peerEnvironmentId: bundle.origin.environmentId,
          peerThreadId: bundle.origin.threadId,
          peerLabel: bundle.origin.label ?? null,
          previousHandoffId: bundle.lineage.previousHandoffId,
          hopCount: bundle.lineage.hopCount,
          updatedAt: now,
        },
        updatedAt: now,
      };
      // The carried conversation replays as this environment's own events —
      // the same message/turn-item pair the v1 importer writes. A returning
      // hop skips every item this side already has, so a round trip adds only
      // what happened away instead of doubling the history.
      const existingItemIds = new Set(
        input.existingItems.map((existingItem) => String(existingItem.id)),
      );
      const conversationEvents: Array<OrchestrationV2DomainEvent> = [];
      for (const item of bundle.conversation.items) {
        if (existingItemIds.has(String(item.id))) continue;
        const localized = localizeTurnItem(item, thread.id);
        if (
          (localized.type === "user_message" || localized.type === "assistant_message") &&
          localized.messageId !== null
        ) {
          conversationEvents.push({
            id: EventId.make(`${HANDOFF_EVENT_PREFIX}:${bundle.handoffId}:message:${item.id}`),
            type: "message.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: {
              createdBy: localized.type === "user_message" ? "user" : "agent",
              creationSource: "server",
              id: localized.messageId,
              threadId: thread.id,
              runId: null,
              nodeId: null,
              role: localized.type === "user_message" ? "user" : "assistant",
              text: localized.text ?? "",
              attachments: localized.type === "user_message" ? localized.attachments : [],
              streaming: false,
              createdAt: localized.startedAt ?? now,
              updatedAt: localized.updatedAt ?? now,
            },
          });
        }
        conversationEvents.push({
          id: EventId.make(`${HANDOFF_EVENT_PREFIX}:${bundle.handoffId}:item:${item.id}`),
          type: "turn-item.updated",
          threadId: thread.id,
          occurredAt: now,
          payload: localized,
        });
      }

      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${HANDOFF_EVENT_PREFIX}:${bundle.handoffId}:thread`),
          type: returning ? "thread.handoff-returned" : "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        },
        ...conversationEvents,
        ...(returning
          ? []
          : [
              {
                id: EventId.make(`${HANDOFF_EVENT_PREFIX}:${bundle.handoffId}:arrived`),
                type: "thread.handoff-arrived" as const,
                threadId: thread.id,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: thread,
              },
            ]),
      ];
      // Through the sink, not the raw event store: the sink applies the
      // projections and broadcasts the shell delta, which is what makes the
      // arrived thread appear on every connected client immediately instead
      // of after the next projection rebuild. Batched, because a long
      // conversation is hundreds of events and one giant write would hold the
      // sink's serial lane for the whole payload.
      for (let index = 0; index < events.length; index += 100) {
        yield* eventSink.write({ events: events.slice(index, index + 100) });
      }
      return thread;
    }).pipe(
      asHandoffError(
        "store_failed",
        "Could not write the arrival into this environment's history.",
      ),
    );

  const receive: ThreadHandoffService["Service"]["receive"] = (input) =>
    // Locked on the origin thread id — the one key both ends of a hop agree
    // on, and the one that identifies the logical thread pair. `prepare`
    // locks the local thread id for the same reason: two hops for one thread
    // must never rewrite the same worktree at once.
    serialize.withLock(
      input.bundle.origin.threadId,
      Effect.gen(function* () {
        const { bundle } = input;
        yield* Effect.forEach(bundle.parts, (part) =>
          verifyStagedPart({ handoffId: bundle.handoffId, part }),
        );

        // A retried transfer must not import, patch and mint a second thread.
        // A hop that already landed reports where it landed and stops.
        const arrivedRows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_thread_handoffs
          WHERE handoff_id = ${bundle.handoffId} AND state = 'arrived'
          LIMIT 1
        `.pipe(Effect.orElseSucceed(() => []));
        const arrivedThreadId = arrivedRows[0]?.thread_id;
        if (arrivedThreadId !== undefined) {
          const landedProjectId = yield* projectionStore
            .getThreadProjection(ThreadId.make(arrivedThreadId))
            .pipe(
              Effect.map((projection): ProjectId | null => projection.thread.projectId),
              Effect.orElseSucceed(() => null),
            );
          if (landedProjectId !== null) {
            return {
              threadId: ThreadId.make(arrivedThreadId),
              projectId: landedProjectId,
              classification: "absorb",
              stashRef: null,
              preTag: null,
            } satisfies ThreadHandoffApplication;
          }
        }

        const branch = bundle.workspace.branch;
        const incomingTip = bundle.workspace.headSha;
        const bundlePart = bundle.parts.find((part) => part.kind === "git-bundle") ?? null;

        // A hop between the same two threads is a revival, not a new copy —
        // even when the client no longer knows the pair. The lineage table
        // remembers every hop this environment took part in, so an incoming
        // origin thread that matches a prior peer lands back in that thread.
        let returningThreadId = input.returningThreadId;
        if (returningThreadId === null) {
          const prior = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_thread_handoffs
            WHERE peer_thread_id = ${bundle.origin.threadId}
            ORDER BY updated_at DESC
            LIMIT 1
          `.pipe(Effect.orElseSucceed(() => []));
          const priorThreadId = prior[0]?.thread_id;
          if (priorThreadId !== undefined) {
            const revivable = yield* projectionStore
              .getThreadProjection(ThreadId.make(priorThreadId))
              .pipe(
                Effect.map((projection) => projection.thread.deletedAt === null),
                Effect.orElseSucceed(() => false),
              );
            if (revivable) {
              returningThreadId = ThreadId.make(priorThreadId);
            }
          }
        }

        const existingProjection =
          returningThreadId === null
            ? null
            : yield* projectionStore
                .getThreadProjection(returningThreadId)
                .pipe(
                  asHandoffError(
                    "thread_missing",
                    `Thread ${returningThreadId} could not be read.`,
                  ),
                );
        const existing = existingProjection?.thread ?? null;

        // A caller-named return target has to belong to this hop's lineage:
        // either it is the copy that departed to the origin thread, or a
        // previous hop of this pair recorded it. Otherwise a bundle could
        // overwrite an unrelated thread's worktree and history.
        if (input.returningThreadId !== null && existing !== null) {
          const linkedByPresence =
            existing.handoff?.presence === "away" &&
            existing.handoff.peerThreadId === bundle.origin.threadId;
          const linkedByLineage =
            linkedByPresence ||
            (yield* sql<{ readonly thread_id: string }>`
              SELECT thread_id FROM orchestration_v2_thread_handoffs
              WHERE thread_id = ${input.returningThreadId}
                AND peer_thread_id = ${bundle.origin.threadId}
              LIMIT 1
            `.pipe(Effect.orElseSucceed(() => []))).length > 0;
          if (!linkedByLineage) {
            return yield* new OrchestrationV2HandoffError({
              reason: "thread_missing",
              detail: `Thread ${input.returningThreadId} is not the return target of this handoff's lineage.`,
              handoffId: bundle.handoffId,
            });
          }
        }

        // A retried first arrival has to land on the thread the previous
        // attempt already recorded. The arrival events are keyed by handoff
        // id, so minting a fresh thread id would have projection dedup drop
        // every event an earlier batch already wrote and leave a half-empty
        // conversation on the new thread. `recordHop` below writes the row
        // before anything is applied, so the row is the record of that choice.
        const priorRows =
          returningThreadId === null
            ? yield* sql<{ readonly thread_id: string }>`
                SELECT thread_id FROM orchestration_v2_thread_handoffs
                WHERE handoff_id = ${bundle.handoffId}
                LIMIT 1
              `.pipe(Effect.orElseSucceed(() => []))
            : [];
        const priorThreadIdForHandoff = priorRows[0]?.thread_id;
        const threadId =
          returningThreadId ??
          (priorThreadIdForHandoff !== undefined
            ? ThreadId.make(priorThreadIdForHandoff)
            : ThreadId.make(`thread:${NodeCrypto.randomUUID()}`));
        // The row exists before anything is written to a repository: `markHop`
        // only updates, so without this a first arrival that dies mid-apply
        // leaves no `applying` row for recovery to roll back.
        yield* recordHop({
          handoffId: bundle.handoffId,
          threadId,
          peerEnvironmentId: bundle.origin.environmentId,
          peerThreadId: bundle.origin.threadId,
          previousHandoffId: bundle.lineage.previousHandoffId,
          hopCount: bundle.lineage.hopCount,
          state: "receiving",
          bundle,
        });

        // No project yet: the bundle carries the whole history, so clone from
        // it, point origin at the real remote, and register the project — no
        // network or credentials needed on this machine.
        let projectId = input.projectId;
        let cloned = false;
        if (projectId === null) {
          if (input.cloneWorkspaceRoot === null || bundlePart === null) {
            return yield* new OrchestrationV2HandoffError({
              reason: "project_missing",
              detail:
                "This environment does not have the repository, and the transfer did not carry enough history to clone it.",
              handoffId: bundle.handoffId,
            });
          }
          yield* markHop({ handoffId: bundle.handoffId, state: "applying", lastError: null });
          const cloneRoot = input.cloneWorkspaceRoot;
          // Only a directory this hop brought into existence may be deleted on
          // failure; one that was already here belongs to someone else.
          const cloneRootExisted = yield* fs
            .exists(cloneRoot)
            .pipe(Effect.orElseSucceed(() => false));
          const clonedProjectId = ProjectId.make(`project:${NodeCrypto.randomUUID()}`);
          // Every step here runs before the `apply` guard below exists, so it
          // carries its own: a half-written clone directory left behind makes
          // every retry fail on an occupied target forever.
          yield* Effect.gen(function* () {
            yield* git
              .cloneFromBundle({
                bundlePath: partPath({ handoffId: bundle.handoffId, kind: "git-bundle" }),
                targetPath: cloneRoot,
                branch,
              })
              .pipe(
                asHandoffError("apply_failed", "Could not clone the repository from the bundle."),
              );
            yield* git
              .setOriginRemote({
                cwd: cloneRoot,
                remoteUrl: bundle.repository.locator.remoteUrl,
              })
              .pipe(Effect.ignore);
            yield* projects
              .create({
                commandId: CommandId.make(`handoff:${bundle.handoffId}:project`),
                projectId: clonedProjectId,
                title:
                  bundle.repository.displayName ?? bundle.repository.name ?? "Imported project",
                workspaceRoot: cloneRoot,
              })
              .pipe(asHandoffError("store_failed", "Could not register the cloned project."));
          }).pipe(
            Effect.onError(() =>
              (cloneRootExisted
                ? Effect.void
                : fs.remove(cloneRoot, { recursive: true }).pipe(Effect.ignore)
              ).pipe(
                Effect.andThen(
                  markHop({
                    handoffId: bundle.handoffId,
                    state: "failed",
                    lastError: "clone from bundle failed",
                  }),
                ),
                Effect.ignore,
              ),
            ),
          );
          projectId = clonedProjectId;
          cloned = true;
        }

        const cwd =
          cloned && input.cloneWorkspaceRoot !== null
            ? input.cloneWorkspaceRoot
            : yield* workspaceRootFor(projectId);
        // A fresh clone already sits at the incoming tip; worktree handling is
        // for repositories that existed here before the hop.
        const wantsWorktree = !cloned && bundle.workspace.strategy.type !== "root";

        let classification: HandoffTipClassification = "advance";
        let preTag: string | null = null;
        // Two checkouts can be stashed in one hop — the repository root and
        // the worktree the thread lands in. One nullable ref for both would
        // make the second stash look already taken and hard-reset over it.
        let rootStashRef: string | null = null;
        let worktreeStashRef: string | null = null;
        let applyCwd = cwd;
        // Set only when this hop added the worktree, so undo removes exactly
        // the ones it created and never a worktree that was already here.
        let createdWorktreePath: string | null = null;
        // True once the branch was attached to that new worktree, i.e. once
        // this hop moved the branch pointer somewhere undo has to put back.
        let movedBranchInCreatedWorktree = false;

        // Everything an apply creates that git will not take back: `reset
        // --hard` leaves new untracked files behind, and the attachment and
        // terminal directories are not in a repository at all.
        const createdPaths: Array<string> = [];
        const listDirectory = (dir: string) =>
          fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        const noteNewEntries = (
          dir: string,
          before: ReadonlyArray<string>,
          after: ReadonlyArray<string>,
        ) => {
          const known = new Set(before);
          for (const entry of after) {
            if (!known.has(entry)) createdPaths.push(path.join(dir, entry));
          }
        };

        // Puts both checkouts back the way they were found. Best effort: it
        // runs on a path that is already failing, and on a state that may only
        // be partly built — the tag and stashes may not exist yet.
        const undo = () =>
          Effect.gen(function* () {
            // `preTag` names the thread branch's old tip, which is only where
            // the checkout this hop moved belongs. When that checkout is not
            // the root, resetting the root to it would throw away whatever
            // unrelated branch the root is sitting on.
            const applyWasRoot = applyCwd === cwd;
            // A worktree this hop added holds the branch. Hard-resetting it is
            // not enough: left registered, it blocks a retry from checking the
            // branch out again. Removed first, so the paths it contains are
            // already gone by the time the loop below runs.
            if (createdWorktreePath !== null) {
              yield* git.removeWorktree({ cwd, path: createdWorktreePath }).pipe(Effect.ignore);
              // Removing the worktree leaves the branch pointer wherever this
              // hop moved it; the reset that would have put it back went with
              // the checkout, so the ref is restored directly.
              if (movedBranchInCreatedWorktree && branch !== null && preTag !== null) {
                yield* git
                  .writeRef({ cwd, ref: `refs/heads/${branch}`, commit: preTag })
                  .pipe(Effect.ignore);
              }
              applyCwd = cwd;
            }
            yield* Effect.forEach(
              createdPaths,
              (target) => fs.remove(target, { recursive: true }).pipe(Effect.ignore),
              { discard: true },
            );
            if (!applyWasRoot && createdWorktreePath === null) {
              yield* rollback({ cwd: applyCwd, preTag, stashRef: worktreeStashRef });
            }
            if (applyWasRoot) {
              yield* rollback({ cwd, preTag, stashRef: rootStashRef });
            } else if (rootStashRef !== null) {
              // The root was never moved, so it only wants its own changes back.
              yield* git.popStash({ cwd, stashRef: rootStashRef }).pipe(Effect.ignore);
            }
          });

        if (bundlePart !== null && !cloned) {
          const bundlePath = partPath({ handoffId: bundle.handoffId, kind: "git-bundle" });
          yield* git
            .importBundle({ cwd, bundlePath })
            .pipe(asHandoffError("apply_failed", "Could not import the incoming git objects."));
        }
        const incomingCommitKnown = yield* git
          .hasCommit({ cwd, commit: incomingTip })
          .pipe(asHandoffError("apply_failed", "Could not inspect the incoming commit."));
        if (!incomingCommitKnown) {
          yield* markHop({
            handoffId: bundle.handoffId,
            state: "failed",
            lastError: "incoming commit missing after import",
          });
          return yield* new OrchestrationV2HandoffError({
            reason: "apply_failed",
            detail:
              "The incoming commit is not available here even after importing the bundle. Fetch the repository on this machine and try again.",
            handoffId: bundle.handoffId,
          });
        }
        const localTip =
          branch === null
            ? null
            : yield* git
                .resolveTip({ cwd, branch })
                .pipe(asHandoffError("apply_failed", "Could not read the local branch tip."));
        classification = classifyIncomingTip({
          localTip,
          incomingTip,
          incomingContainsLocal:
            localTip !== null &&
            (yield* git
              .isAncestor({ cwd, ancestor: localTip, descendant: incomingTip })
              .pipe(asHandoffError("apply_failed", "Could not compare the branch tips."))),
          localContainsIncoming:
            localTip !== null &&
            (yield* git
              .isAncestor({ cwd, ancestor: incomingTip, descendant: localTip })
              .pipe(asHandoffError("apply_failed", "Could not compare the branch tips."))),
          hasCommonAncestor:
            localTip !== null &&
            (yield* git
              .hasCommonAncestor({ cwd, left: localTip, right: incomingTip })
              .pipe(asHandoffError("apply_failed", "Could not compare the branch tips."))),
        });

        if (classification === "diverged" || classification === "unrelated") {
          // Park the sender's commits and stop. Nothing on either machine has
          // moved, and the user is left holding both histories.
          const parkedRef = handoffRefName(bundle.origin.environmentId, branch ?? "HEAD");
          yield* git
            .writeRef({ cwd, ref: parkedRef, commit: incomingTip })
            .pipe(asHandoffError("apply_failed", "Could not park the incoming commits."));
          yield* markHop({
            handoffId: bundle.handoffId,
            state: "failed",
            lastError: `branch ${classification}`,
          });
          return yield* new OrchestrationV2HandoffError({
            reason: "workspace_diverged",
            detail: `The branch moved on both machines, so nothing here was changed. The incoming commits are at ${parkedRef}.`,
            handoffId: bundle.handoffId,
          });
        }

        // From here on the checkouts are really being written — the tag, the
        // stashes, the worktree and the patch alike. Every one of those steps
        // has to put both checkouts back and mark the hop failed, or the
        // repository is left half-applied with the user's changes stashed away.
        let failureNote = "apply failed";
        const apply = Effect.gen(function* () {
          if (localTip !== null) {
            preTag = handoffPreTagName(bundle.handoffId);
            yield* git
              .tagCommit({ cwd, tag: preTag, commit: localTip })
              .pipe(asHandoffError("apply_failed", "Could not tag the current tip."));
            rootStashRef = yield* git
              .stashWorktree({ cwd, label: handoffStashLabel(bundle.handoffId, localTip) })
              .pipe(asHandoffError("apply_failed", "Could not set the local changes aside."));
          }
          // The row names what a crash has to be rolled back from, so it is
          // written before the tree moves rather than after the hop lands.
          yield* markHop({
            handoffId: bundle.handoffId,
            state: "applying",
            lastError: null,
            appliedHeadSha: incomingTip,
            rootStashRef,
            preTag,
            applyCwd: cwd,
            rootCwd: cwd,
          });

          if (classification === "advance" && branch !== null && !wantsWorktree) {
            yield* git
              .checkoutBranchAt({ cwd, branch, commit: incomingTip })
              .pipe(
                asHandoffError("apply_failed", "Could not move the branch to the incoming commit."),
              );
          }

          // A detached-HEAD thread has no branch to move, so the working tree
          // is put on the incoming commit directly. Without this the patch
          // lands on whatever commit this side happened to be sitting on.
          if (classification === "advance" && branch === null && bundlePart !== null) {
            const head = yield* git
              .resolveHead({ cwd })
              .pipe(asHandoffError("apply_failed", "Could not read the local HEAD."));
            if (head !== incomingTip) {
              preTag = handoffPreTagName(bundle.handoffId);
              yield* git
                .tagCommit({ cwd, tag: preTag, commit: head })
                .pipe(asHandoffError("apply_failed", "Could not tag the current tip."));
              rootStashRef = yield* git
                .stashWorktree({ cwd, label: handoffStashLabel(bundle.handoffId, head) })
                .pipe(asHandoffError("apply_failed", "Could not set the local changes aside."));
              yield* markHop({
                handoffId: bundle.handoffId,
                state: "applying",
                lastError: null,
                rootStashRef,
                preTag,
                applyCwd: cwd,
                rootCwd: cwd,
              });
              yield* git
                .resetHardTo({ cwd, commit: incomingTip })
                .pipe(
                  asHandoffError(
                    "apply_failed",
                    "Could not move the working tree to the incoming commit.",
                  ),
                );
            }
          }

          // A thread that lived in a worktree lands in one here too: reuse the
          // worktree that already has the branch checked out, otherwise add a
          // fresh one at the incoming commit. The branch attaches only when no
          // other checkout holds it — git forbids two checkouts of one branch,
          // and a detached worktree at the right commit still runs the thread.
          if (wantsWorktree && branch !== null) {
            const existingWorktree = yield* git
              .findWorktreeForBranch({ cwd, branch })
              .pipe(
                asHandoffError("apply_failed", "Could not inspect the repository's worktrees."),
              );
            if (existingWorktree !== null && existingWorktree !== cwd) {
              applyCwd = existingWorktree;
              // Its own stash, taken before its own reset: the root's stash says
              // nothing about what this worktree is holding.
              worktreeStashRef = yield* git
                .stashWorktree({
                  cwd: applyCwd,
                  label: handoffStashLabel(bundle.handoffId, incomingTip),
                })
                .pipe(
                  asHandoffError("apply_failed", "Could not set the worktree's changes aside."),
                );
              yield* markHop({
                handoffId: bundle.handoffId,
                state: "applying",
                lastError: null,
                stashRef: worktreeStashRef,
                applyCwd,
              });
              if (classification === "advance") {
                yield* git
                  .resetHardTo({ cwd: applyCwd, commit: incomingTip })
                  .pipe(asHandoffError("apply_failed", "Could not advance the worktree."));
              }
            } else if (existingWorktree === null) {
              const worktreePath = path.join(
                config.worktreesDir,
                `handoff-${bundle.handoffId.slice(0, 8)}`,
              );
              yield* git
                .addWorktree({ cwd, path: worktreePath, commit: incomingTip })
                .pipe(
                  asHandoffError("apply_failed", "Could not create a worktree for the thread."),
                );
              applyCwd = worktreePath;
              createdWorktreePath = worktreePath;
              yield* markHop({
                handoffId: bundle.handoffId,
                state: "applying",
                lastError: null,
                applyCwd,
                createdWorktree: true,
              });
              const branchTaken = yield* git
                .isBranchCheckedOut({ cwd, branch })
                .pipe(
                  asHandoffError("apply_failed", "Could not inspect the repository's worktrees."),
                );
              if (!branchTaken) {
                yield* git
                  .checkoutBranchAt({ cwd: applyCwd, branch, commit: incomingTip })
                  .pipe(
                    asHandoffError("apply_failed", "Could not attach the branch to the worktree."),
                  );
                movedBranchInCreatedWorktree = true;
              }
            }
          }

          const patchPart = bundle.parts.find((part) => part.kind === "tracked-patch") ?? null;
          const patch =
            patchPart === null
              ? null
              : yield* fs
                  .readFileString(partPath({ handoffId: bundle.handoffId, kind: "tracked-patch" }))
                  .pipe(asHandoffError("store_failed", "Could not read the staged patch."));
          if (patch !== null) {
            // Dry run first: a patch that will not apply must leave the working
            // tree exactly as it was, not half-written.
            const applies = yield* git
              .applyPatch({ cwd: applyCwd, patch, check: true })
              .pipe(asHandoffError("apply_failed", "Could not test the incoming changes."));
            if (!applies) {
              failureNote = "patch did not apply";
              return yield* new OrchestrationV2HandoffError({
                reason: "apply_failed",
                detail:
                  "The incoming changes could not be applied here, so this repository was put back exactly as it was.",
                handoffId: bundle.handoffId,
              });
            }
          }

          failureNote = "apply failed after the patch check";
          // Snapshotted before anything is written so undo knows exactly which
          // files this hop brought into existence.
          const untrackedBefore = yield* git
            .untrackedPaths({ cwd: applyCwd })
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          if (patch !== null) {
            yield* git
              .applyPatch({ cwd: applyCwd, patch, check: false })
              .pipe(asHandoffError("apply_failed", "Could not apply the incoming changes."));
          }

          if (bundle.parts.some((part) => part.kind === "untracked-tar")) {
            yield* git
              .extractArchive({
                cwd: applyCwd,
                archivePath: partPath({ handoffId: bundle.handoffId, kind: "untracked-tar" }),
              })
              .pipe(asHandoffError("apply_failed", "Could not restore the untracked files."));
          }
          noteNewEntries(
            applyCwd,
            untrackedBefore,
            yield* git
              .untrackedPaths({ cwd: applyCwd })
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)),
          );

          if (bundle.parts.some((part) => part.kind === "attachments-tar")) {
            const attachmentsBefore = yield* listDirectory(config.attachmentsDir);
            yield* git
              .extractArchive({
                cwd: config.attachmentsDir,
                archivePath: partPath({ handoffId: bundle.handoffId, kind: "attachments-tar" }),
              })
              .pipe(asHandoffError("apply_failed", "Could not restore the thread's attachments."));
            noteNewEntries(
              config.attachmentsDir,
              attachmentsBefore,
              yield* listDirectory(config.attachmentsDir),
            );
          }

          if (bundle.parts.some((part) => part.kind === "terminals-tar")) {
            const terminalsBefore = yield* listDirectory(config.terminalLogsDir);
            yield* git
              .extractArchive({
                cwd: config.terminalLogsDir,
                archivePath: partPath({ handoffId: bundle.handoffId, kind: "terminals-tar" }),
              })
              .pipe(asHandoffError("apply_failed", "Could not restore the thread's terminals."));
            // History files are named by thread id, and the thread has a new id
            // here; rename the extracted files so the manager finds them.
            const originPrefix = terminalHistoryFilePrefix(bundle.origin.threadId);
            const localPrefix = terminalHistoryFilePrefix(threadId);
            if (originPrefix !== localPrefix) {
              const extracted = yield* fs.readDirectory(config.terminalLogsDir).pipe(
                Effect.map((entries) =>
                  entries.filter(
                    (entry) =>
                      entry === `${originPrefix}.log` || entry.startsWith(`${originPrefix}_`),
                  ),
                ),
                Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
              );
              // A rename that fails leaves scrollback under the origin prefix
              // where the terminal manager will never look. It is not worth
              // failing the hop over, but it is worth saying out loud.
              const unrenamed = yield* Effect.forEach(extracted, (entry) =>
                fs
                  .rename(
                    path.join(config.terminalLogsDir, entry),
                    path.join(
                      config.terminalLogsDir,
                      `${localPrefix}${entry.slice(originPrefix.length)}`,
                    ),
                  )
                  .pipe(
                    Effect.as<ReadonlyArray<string>>([]),
                    Effect.orElseSucceed((): ReadonlyArray<string> => [entry]),
                  ),
              );
              const failedRenames = unrenamed.flat();
              if (failedRenames.length > 0) {
                yield* Effect.logWarning("orchestrationV2.handoff.terminalHistoryRenameFailed", {
                  handoffId: bundle.handoffId,
                  threadId,
                  entries: failedRenames,
                });
              }
            }
            // After the renames, so the names undo deletes are the ones that
            // are actually on disk.
            noteNewEntries(
              config.terminalLogsDir,
              terminalsBefore,
              yield* listDirectory(config.terminalLogsDir),
            );
          }
          yield* writeArrival({
            bundle,
            threadId,
            projectId,
            existing,
            existingItems: existingProjection?.turnItems ?? [],
            worktreePath: wantsWorktree && applyCwd !== cwd ? applyCwd : null,
          });
          yield* recordHop({
            handoffId: bundle.handoffId,
            threadId,
            peerEnvironmentId: bundle.origin.environmentId,
            peerThreadId: bundle.origin.threadId,
            previousHandoffId: bundle.lineage.previousHandoffId,
            hopCount: bundle.lineage.hopCount,
            state: "arrived",
            bundle,
          });
          yield* markHop({
            handoffId: bundle.handoffId,
            state: "arrived",
            lastError: null,
            appliedHeadSha: incomingTip,
            stashRef: worktreeStashRef,
            rootStashRef,
            preTag,
            applyCwd,
            rootCwd: cwd,
          });

          // The receiver's own dirty changes were only set aside for the
          // duration of the apply; a landed hop hands them back. Each stash
          // pops against the checkout it was taken in. A pop that conflicts
          // must not fail a hop that already succeeded: the stash stays, its
          // ref stays on the row, and the warning names it so the user can pop
          // it by hand. Only cleanly popped refs are cleared.
          for (const stash of [
            { ref: worktreeStashRef, stashCwd: applyCwd, root: false },
            { ref: rootStashRef, stashCwd: cwd, root: true },
          ]) {
            if (stash.ref === null) continue;
            const popped = yield* git.popStash({ cwd: stash.stashCwd, stashRef: stash.ref }).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (!popped) {
              yield* Effect.logWarning("orchestrationV2.handoff.stashPopFailed", {
                handoffId: bundle.handoffId,
                threadId,
                cwd: stash.stashCwd,
                stashRef: stash.ref,
              });
              continue;
            }
            if (stash.root) {
              rootStashRef = null;
              yield* sql`
                UPDATE orchestration_v2_thread_handoffs
                SET root_stash_ref = NULL WHERE handoff_id = ${bundle.handoffId}
              `.pipe(Effect.ignore);
            } else {
              worktreeStashRef = null;
              yield* sql`
                UPDATE orchestration_v2_thread_handoffs
                SET stash_ref = NULL WHERE handoff_id = ${bundle.handoffId}
              `.pipe(Effect.ignore);
            }
          }
        });
        yield* apply.pipe(
          Effect.onError(() =>
            undo().pipe(
              Effect.andThen(
                markHop({
                  handoffId: bundle.handoffId,
                  state: "failed",
                  lastError: failureNote,
                }),
              ),
              Effect.ignore,
            ),
          ),
        );

        return {
          threadId,
          projectId,
          classification,
          stashRef: worktreeStashRef ?? rootStashRef,
          preTag,
        } satisfies ThreadHandoffApplication;
      }),
    );

  const recoverInterrupted: ThreadHandoffService["Service"]["recoverInterrupted"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly handoff_id: string;
        readonly thread_id: string;
        readonly state: string;
        readonly stash_ref: string | null;
        readonly root_stash_ref: string | null;
        readonly pre_tag: string | null;
        readonly apply_cwd: string | null;
        readonly root_cwd: string | null;
        readonly created_worktree: number;
        readonly manifest_json: string;
      }>`
        SELECT handoff_id, thread_id, state, stash_ref, root_stash_ref, pre_tag, apply_cwd,
               root_cwd, created_worktree, manifest_json
        FROM orchestration_v2_thread_handoffs
        WHERE state = 'applying'
           OR (state = 'arrived' AND (stash_ref IS NOT NULL OR root_stash_ref IS NOT NULL))
      `;
      yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            // A hop that arrived but stopped before handing the stashes back
            // only owes those pops: the arrival itself is done and stays.
            if (row.state === "arrived") {
              yield* Effect.gen(function* () {
                const rootCwd = row.root_cwd ?? row.apply_cwd;
                if (rootCwd === null) return;
                const applyCwd = row.apply_cwd ?? rootCwd;
                for (const stash of [
                  { ref: row.stash_ref, cwd: applyCwd, column: "stash_ref" as const },
                  { ref: row.root_stash_ref, cwd: rootCwd, column: "root_stash_ref" as const },
                ]) {
                  if (stash.ref === null) continue;
                  const popped = yield* git.popStash({ cwd: stash.cwd, stashRef: stash.ref }).pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  );
                  if (!popped) continue;
                  yield* (
                    stash.column === "stash_ref"
                      ? sql`
                        UPDATE orchestration_v2_thread_handoffs
                        SET stash_ref = NULL WHERE handoff_id = ${row.handoff_id}
                      `
                      : sql`
                        UPDATE orchestration_v2_thread_handoffs
                        SET root_stash_ref = NULL WHERE handoff_id = ${row.handoff_id}
                      `
                  ).pipe(Effect.ignore);
                }
              }).pipe(Effect.ignore);
              return;
            }
            // A hop that died mid-apply left a written tree behind. Put it
            // back where the tag and stash say it was before marking the hop
            // failed — best effort, since the worktree may itself be gone.
            if (row.pre_tag !== null || row.stash_ref !== null || row.root_stash_ref !== null) {
              yield* Effect.gen(function* () {
                // The row's own directories first: a first arrival that died
                // before its history was written has no projection to read a
                // working directory from.
                const fallback = () =>
                  projectionStore
                    .getThreadProjection(ThreadId.make(row.thread_id))
                    .pipe(Effect.flatMap((projection) => threadCwd(projection.thread)));
                const rootCwd = row.root_cwd ?? row.apply_cwd ?? (yield* fallback());
                const applyCwd = row.apply_cwd ?? rootCwd;
                // Each stash belongs to the checkout it was taken in; popping
                // the worktree's against the root, or the other way round,
                // drops the changes into the wrong tree.
                if (applyCwd !== rootCwd) {
                  if (row.created_worktree !== 0) {
                    // The worktree was this hop's to make, so it is this
                    // hop's to remove — a retry derives the same path and
                    // would otherwise find it occupied forever. The branch it
                    // held is put back at its old tip when one is recorded.
                    yield* git.removeWorktree({ cwd: rootCwd, path: applyCwd }).pipe(Effect.ignore);
                    const branchName = yield* decodeManifest(row.manifest_json).pipe(
                      Effect.map((manifest) => manifest.workspace.branch),
                      Effect.orElseSucceed(() => null),
                    );
                    if (branchName !== null && row.pre_tag !== null) {
                      yield* git
                        .writeRef({
                          cwd: rootCwd,
                          ref: `refs/heads/${branchName}`,
                          commit: row.pre_tag,
                        })
                        .pipe(Effect.ignore);
                    }
                  } else {
                    // The tag names the thread branch's old tip, which only
                    // the checkout the hop moved may be reset to. The root
                    // sits on its own branch and just wants its changes back.
                    yield* rollback({
                      cwd: applyCwd,
                      preTag: row.pre_tag,
                      stashRef: row.stash_ref,
                    });
                  }
                  if (row.root_stash_ref !== null) {
                    yield* git
                      .popStash({ cwd: rootCwd, stashRef: row.root_stash_ref })
                      .pipe(Effect.ignore);
                  }
                } else {
                  yield* rollback({
                    cwd: rootCwd,
                    preTag: row.pre_tag,
                    stashRef: row.root_stash_ref ?? row.stash_ref,
                  });
                }
              }).pipe(Effect.ignore);
            }
            yield* markHop({
              handoffId: ThreadHandoffId.make(row.handoff_id),
              state: "failed",
              lastError: "server stopped while applying",
            });
          }).pipe(Effect.ignore),
        { discard: true },
      );
      return rows.length;
    }).pipe(Effect.orElseSucceed(() => 0));

  return {
    prepare,
    partPath,
    verifyStagedPart,
    receive,
    recoverInterrupted,
  } satisfies ThreadHandoffService["Service"];
});

export const layer: Layer.Layer<
  ThreadHandoffService,
  never,
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | EventSinkV2
  | ProjectionStoreV2
  | ThreadHandoffGit
  | ProjectService.ProjectService
  | RepositoryIdentityResolver.RepositoryIdentityResolver
  | ServerEnvironment.ServerEnvironment
  | ProviderAdapterRegistryV2
> = Layer.effect(ThreadHandoffService, make);
