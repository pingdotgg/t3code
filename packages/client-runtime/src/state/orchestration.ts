import { msg } from "gt-i18n";
import { translatableMessage } from "../errors/translatable.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadLinkMetadata,
  ThreadId,
  type EnvironmentId,
  type OrchestrationGetTurnDiffResult,
  type OrchestrationV2GetTurnItemInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
  type CommandOutputView,
} from "./commandOutput.ts";

import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentCommand,
  type QueryAnswerHandler,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelayDpopSigner from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError, requestInSession } from "../rpc/client.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";

// Cap per-RPC thread-id chunks and coalesced resolver entries to keep metadata queries bounded.
const THREAD_LINK_METADATA_CHUNK_SIZE = 500;
const THREAD_LINK_METADATA_MAX_BATCH_ENTRIES = 500;
const THREAD_LINK_METADATA_STALE_TIME_MS = 60_000;
const THREAD_LINK_METADATA_CACHE_LIMIT = 2048;

type ThreadLinkMetadataMap = Readonly<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>>;
type ThreadLinkMetadataError =
  | Effect.Error<ReturnType<typeof fetchThreadLinkMetadataChunk>>
  | EnvironmentRpcUnavailableError;

/** Raised when at least one chunk or cached entry succeeded while another chunk failed. */
export class PartialThreadLinkMetadataError extends Schema.TaggedError<PartialThreadLinkMetadataError>()(
  "PartialThreadLinkMetadataError",
  {
    metadata: Schema.Record(ThreadId, OrchestrationV2ThreadLinkMetadata),
    failedThreadIds: Schema.Array(ThreadId),
    cause: Schema.Unknown,
  },
) {}

interface CachedThreadLinkMetadata {
  readonly value: OrchestrationV2ThreadLinkMetadata | null;
  readonly expiresAt: number;
  readonly shellGeneration: number;
  readonly removedAtSeq: number;
}

interface InFlightThreadLinkMetadata {
  readonly threadId: ThreadId;
  readonly shellGeneration: number;
  readonly removedAtSeq: number;
  readonly deferred: Deferred.Deferred<
    OrchestrationV2ThreadLinkMetadata | null,
    ThreadLinkMetadataError
  >;
}

class ThreadLinkMetadataRequest extends Request.Class<
  {
    readonly flights: ReadonlyArray<InFlightThreadLinkMetadata>;
    readonly session: RpcSession.RpcSession;
    readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    readonly registry: AtomRegistry.AtomRegistry;
  },
  void,
  never
> {}

const metadataMapToRecord = (
  entries: ReadonlyMap<ThreadId, OrchestrationV2ThreadLinkMetadata>,
): ThreadLinkMetadataMap => Object.fromEntries(entries) as ThreadLinkMetadataMap;

// Runs inside orchestration.threadLinkMetadata, which owns the span.
const assertSessionActive = Effect.fnUntraced(function* (
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
  session: RpcSession.RpcSession,
) {
  const current = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(current) || current.value !== session) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      ...translatableMessage(msg("The environment has no session.")),
    });
  }
});

const fetchThreadLinkMetadataChunk = Effect.fn("orchestration.fetchThreadLinkMetadataChunk")(
  function* (
    supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
    session: RpcSession.RpcSession,
    chunk: ReadonlyArray<ThreadId>,
  ) {
    const merged = new Map<ThreadId, OrchestrationV2ThreadLinkMetadata>();
    const config = yield* session.initialConfig;
    if (config.threadLinkMetadata === true) {
      const response = yield* requestInSession(
        session,
        ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata,
        { threadIds: chunk },
      ).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      for (const threadId of chunk) {
        if (!Object.hasOwn(response, threadId)) continue;
        const entry = response[threadId];
        if (entry !== undefined) merged.set(threadId, entry);
      }
    } else {
      const titles = yield* requestInSession(session, ORCHESTRATION_V2_WS_METHODS.getThreadTitles, {
        threadIds: chunk,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      for (const threadId of chunk) {
        if (!Object.hasOwn(titles, threadId)) continue;
        const title = titles[threadId];
        if (title !== undefined) merged.set(threadId, { title, projectId: null });
      }
    }
    return merged;
  },
);

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  options: {
    /** Re-checks thread lookups when a thread leaves the shell or a shell snapshot arrives (`generation`), and the archive on any removal. */
    readonly shellState?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<Pick<EnvironmentShellState, "removedAt" | "generation">>;
    /** Runs on each turn-range and full-thread diff the server answers. */
    readonly onCheckpointDiffAnswer?: QueryAnswerHandler<
      { readonly ignoreWhitespace?: boolean },
      OrchestrationGetTurnDiffResult
    >;
  } = {},
) {
  const onCheckpointDiffAnswer =
    options.onCheckpointDiffAnswer === undefined
      ? {}
      : { onAnswer: options.onCheckpointDiffAnswer };
  const shellState = options.shellState;
  const liveTurnItem = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:turn-item",
    tag: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
  });
  // A settled item's revision is its updatedAt, so the answer for it never goes stale.
  const settledTurnItem = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:turn-item",
    tag: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 5 * 60_000,
  });
  const refreshThreadLookup = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadIds: ReadonlyArray<ThreadId> };
  }) => {
    if (shellState === undefined) return undefined;
    const state = shellState(environmentId);
    return Atom.make((get) => {
      const { removedAt, generation } = get(state);
      let latest = -1;
      for (const threadId of input.threadIds) {
        const seq = removedAt.get(threadId);
        if (seq !== undefined && seq > latest) latest = seq;
      }
      return `${generation}:${latest}`;
    });
  };
  // Keyed by session so a reconnect never serves or joins the previous session's lookups.
  const threadLinkMetadataCache = new WeakMap<
    RpcSession.RpcSession,
    Map<ThreadId, CachedThreadLinkMetadata>
  >();
  const inFlightThreadLinkMetadata = new WeakMap<
    RpcSession.RpcSession,
    Map<ThreadId, InFlightThreadLinkMetadata>
  >();
  const readShellVersion = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    if (shellState === undefined) return { generation: 0, removedAt: undefined };
    const { generation, removedAt } = registry.get(shellState(environmentId));
    return { generation, removedAt };
  };
  const clearInFlight = (session: RpcSession.RpcSession, flight: InFlightThreadLinkMetadata) => {
    const flights = inFlightThreadLinkMetadata.get(session);
    if (flights?.get(flight.threadId) === flight) {
      flights.delete(flight.threadId);
    }
  };
  const settleFlight = (
    session: RpcSession.RpcSession,
    flight: InFlightThreadLinkMetadata,
    exit: Exit.Exit<OrchestrationV2ThreadLinkMetadata | null, ThreadLinkMetadataError>,
  ) => {
    clearInFlight(session, flight);
    Deferred.doneUnsafe(flight.deferred, exit);
  };
  const getOrCreateInFlight = (
    session: RpcSession.RpcSession,
    threadId: ThreadId,
    shellGeneration: number,
    removedAtSeq: number,
  ): { readonly flight: InFlightThreadLinkMetadata; readonly created: boolean } => {
    let flights = inFlightThreadLinkMetadata.get(session);
    if (flights === undefined) {
      flights = new Map();
      inFlightThreadLinkMetadata.set(session, flights);
    }
    const existing = flights.get(threadId);
    if (
      existing !== undefined &&
      existing.shellGeneration === shellGeneration &&
      existing.removedAtSeq === removedAtSeq
    ) {
      return { flight: existing, created: false };
    }
    const created: InFlightThreadLinkMetadata = {
      threadId,
      shellGeneration,
      removedAtSeq,
      deferred: Deferred.makeUnsafe(),
    };
    flights.set(threadId, created);
    return { flight: created, created: true };
  };
  const getCachedThreadLinkMetadata = (
    session: RpcSession.RpcSession,
    threadId: ThreadId,
    now: number,
    generation: number,
    removedAtSeq: number,
  ): CachedThreadLinkMetadata | undefined => {
    const entries = threadLinkMetadataCache.get(session);
    const cached = entries?.get(threadId);
    if (entries === undefined || cached === undefined) return undefined;
    if (
      cached.expiresAt <= now ||
      cached.shellGeneration !== generation ||
      cached.removedAtSeq !== removedAtSeq
    ) {
      return undefined;
    }
    entries.delete(threadId);
    entries.set(threadId, cached);
    return cached;
  };
  const rememberThreadLinkMetadata = (
    session: RpcSession.RpcSession,
    threadId: ThreadId,
    cached: CachedThreadLinkMetadata,
  ) => {
    let entries = threadLinkMetadataCache.get(session);
    if (entries === undefined) {
      entries = new Map();
      threadLinkMetadataCache.set(session, entries);
    }
    entries.delete(threadId);
    entries.set(threadId, cached);
    while (entries.size > THREAD_LINK_METADATA_CACHE_LIMIT) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  const threadLinkMetadataResolver = RequestResolver.makeWith<ThreadLinkMetadataRequest>({
    batchKey: (entry) => entry.request.session,
    delay: Effect.yieldNow,
    collectWhile: (entries) => entries.size < THREAD_LINK_METADATA_MAX_BATCH_ENTRIES,
    // Each caller already opens an `orchestration.threadLinkMetadata` span.
    runAll: Effect.fnUntraced(function* (entries) {
      const first = entries[0];
      if (first === undefined) return;
      const { session, supervisor, registry } = first.request;
      const environmentId = supervisor.target.environmentId;
      const initialShell = readShellVersion(registry, environmentId);
      const batchGeneration = initialShell.generation;
      const supersededExit = () =>
        Exit.fail(
          new EnvironmentRpcUnavailableError({
            environmentId,
            ...translatableMessage(msg("The environment has no session.")),
          }),
        );
      const flightsById = new Map<ThreadId, Array<InFlightThreadLinkMetadata>>();
      for (const entry of entries) {
        for (const flight of entry.request.flights) {
          if (
            flight.shellGeneration !== batchGeneration ||
            flight.removedAtSeq !== (initialShell.removedAt?.get(flight.threadId) ?? -1)
          ) {
            settleFlight(session, flight, supersededExit());
            continue;
          }
          let list = flightsById.get(flight.threadId);
          if (list === undefined) {
            list = [];
            flightsById.set(flight.threadId, list);
          }
          list.push(flight);
        }
      }
      const uniqueIds = [...flightsById.keys()];
      let nextOffset = 0;

      const settleIds = (
        ids: ReadonlyArray<ThreadId>,
        exitFor: (
          threadId: ThreadId,
        ) => Exit.Exit<OrchestrationV2ThreadLinkMetadata | null, ThreadLinkMetadataError>,
      ) => {
        for (const threadId of ids) {
          const flights = flightsById.get(threadId);
          if (flights === undefined) continue;
          const exit = exitFor(threadId);
          for (const flight of flights) {
            settleFlight(session, flight, exit);
          }
        }
      };

      const failRemaining = (exit: Exit.Exit<never, ThreadLinkMetadataError>) => {
        settleIds(uniqueIds.slice(nextOffset), () => exit);
        nextOffset = uniqueIds.length;
      };

      yield* Effect.gen(function* () {
        for (let offset = 0; offset < uniqueIds.length; offset += THREAD_LINK_METADATA_CHUNK_SIZE) {
          const sessionExit = yield* Effect.exit(assertSessionActive(supervisor, session));
          if (Exit.isFailure(sessionExit)) {
            failRemaining(Exit.failCause(sessionExit.cause));
            return;
          }
          const before = readShellVersion(registry, environmentId);
          // Stop before dispatching another chunk once a shell snapshot supersedes this batch.
          if (before.generation !== batchGeneration) {
            failRemaining(supersededExit());
            return;
          }
          const rawChunk = uniqueIds.slice(offset, offset + THREAD_LINK_METADATA_CHUNK_SIZE);
          const chunk: Array<ThreadId> = [];
          for (const threadId of rawChunk) {
            if (
              (before.removedAt?.get(threadId) ?? -1) !==
              (initialShell.removedAt?.get(threadId) ?? -1)
            ) {
              settleIds([threadId], supersededExit);
              continue;
            }
            chunk.push(threadId);
          }
          if (chunk.length === 0) {
            nextOffset = offset + rawChunk.length;
            continue;
          }
          const chunkExit = yield* Effect.exit(
            fetchThreadLinkMetadataChunk(supervisor, session, chunk),
          );
          if (Exit.isFailure(chunkExit)) {
            settleIds(chunk, () => Exit.failCause(chunkExit.cause));
            nextOffset = offset + rawChunk.length;
            continue;
          }
          const now = yield* Clock.currentTimeMillis;
          const after = readShellVersion(registry, environmentId);
          // A removal or snapshot that landed while the chunk was in flight makes its answer stale.
          if (before.generation === after.generation) {
            for (const threadId of chunk) {
              const removedAtSeq = before.removedAt?.get(threadId) ?? -1;
              if ((after.removedAt?.get(threadId) ?? -1) !== removedAtSeq) continue;
              rememberThreadLinkMetadata(session, threadId, {
                value: chunkExit.value.get(threadId) ?? null,
                expiresAt: now + THREAD_LINK_METADATA_STALE_TIME_MS,
                shellGeneration: before.generation,
                removedAtSeq,
              });
            }
          }
          settleIds(chunk, (threadId) => Exit.succeed(chunkExit.value.get(threadId) ?? null));
          nextOffset = offset + rawChunk.length;
        }
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && nextOffset < uniqueIds.length) {
              failRemaining(Exit.failCause(exit.cause as Cause.Cause<ThreadLinkMetadataError>));
            }
            for (const entry of entries) {
              entry.completeUnsafe(Exit.void);
            }
          }),
        ),
      );
    }),
  });
  return {
    threadTitles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-titles",
      tag: ORCHESTRATION_V2_WS_METHODS.getThreadTitles,
      staleTimeMs: 0,
      idleTtlMs: 0,
      // Deleting a thread the shell already left out keeps these ids, so the query would not rerun.
      // A removal can also be an archive, so it only prompts a re-check.
      refreshTrigger: refreshThreadLookup,
    }),
    threadLinkMetadata: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-link-metadata",
      // Let the per-thread 60 s LRU govern freshness and drop idle prefix keys immediately.
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshTrigger: refreshThreadLookup,
      execute: Effect.fn("orchestration.threadLinkMetadata")(function* (
        input: { readonly threadIds: ReadonlyArray<ThreadId> },
        emit: (value: ThreadLinkMetadataMap) => Effect.Effect<void>,
        previous: Option.Option<ThreadLinkMetadataMap>,
      ) {
        if (input.threadIds.length === 0) return {};
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const sessionOption = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(sessionOption)) {
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            ...translatableMessage(msg("The environment has no session.")),
          });
        }
        const session = sessionOption.value;
        const registry = yield* AtomRegistry.AtomRegistry;
        const environmentId = supervisor.target.environmentId;
        const now = yield* Clock.currentTimeMillis;
        const { generation, removedAt } = readShellVersion(registry, environmentId);
        const resolved = new Map<ThreadId, OrchestrationV2ThreadLinkMetadata>();
        const awaiting: Array<InFlightThreadLinkMetadata> = [];
        let succeededCount = 0;

        // Register in-flight entries and enqueue them uninterruptibly so no entry is ever orphaned.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const toFetch: Array<InFlightThreadLinkMetadata> = [];
            const seen = new Set<ThreadId>();
            for (const threadId of input.threadIds) {
              if (seen.has(threadId)) continue;
              seen.add(threadId);
              const removedAtSeq = removedAt?.get(threadId) ?? -1;
              const cached = getCachedThreadLinkMetadata(
                session,
                threadId,
                now,
                generation,
                removedAtSeq,
              );
              if (cached !== undefined) {
                succeededCount++;
                if (cached.value !== null) resolved.set(threadId, cached.value);
                continue;
              }
              const { flight, created } = getOrCreateInFlight(
                session,
                threadId,
                generation,
                removedAtSeq,
              );
              awaiting.push(flight);
              if (created) toFetch.push(flight);
            }
            if (toFetch.length === 0) return;
            yield* Effect.request(
              new ThreadLinkMetadataRequest({
                flights: toFetch,
                session,
                supervisor,
                registry,
              }),
              threadLinkMetadataResolver,
            ).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) {
                    for (const flight of toFetch) {
                      settleFlight(session, flight, Exit.failCause(exit.cause));
                    }
                  }
                }),
              ),
              Effect.ignoreCause,
              Effect.forkDetach({ startImmediately: true }),
            );
          }),
        );

        if (awaiting.length === 0) return metadataMapToRecord(resolved);
        if (Option.isNone(previous) && resolved.size > 0) {
          yield* emit(metadataMapToRecord(resolved));
        }
        const failedThreadIds: Array<ThreadId> = [];
        let firstFailureCause: Cause.Cause<ThreadLinkMetadataError> | undefined;
        for (const flight of awaiting) {
          const exit = yield* Effect.exit(Deferred.await(flight.deferred));
          if (Exit.isSuccess(exit)) {
            succeededCount++;
            if (exit.value !== null) resolved.set(flight.threadId, exit.value);
          } else {
            failedThreadIds.push(flight.threadId);
            firstFailureCause ??= exit.cause;
          }
        }
        const metadata = metadataMapToRecord(resolved);
        if (failedThreadIds.length === 0) return metadata;
        yield* assertSessionActive(supervisor, session);
        const latestShell = readShellVersion(registry, environmentId);
        if (
          succeededCount === 0 ||
          latestShell.generation !== generation ||
          failedThreadIds.some(
            (threadId) =>
              (latestShell.removedAt?.get(threadId) ?? -1) !== (removedAt?.get(threadId) ?? -1),
          )
        ) {
          return yield* Effect.failCause(firstFailureCause!);
        }
        yield* emit(metadata);
        return yield* new PartialThreadLinkMetadataError({
          metadata,
          failedThreadIds,
          cause: Cause.squash(firstFailureCause!),
        });
      }),
    }),
    threadTranscript: createEnvironmentCommand(runtime, {
      label: "environment-data:orchestration:thread-transcript",
      execute: Effect.fn("orchestration.execute")(function* (input: {
        readonly threadId: ThreadId;
      }) {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            ...translatableMessage(msg("The source environment is not connected.")),
          });
        }
        return yield* fetchEnvironmentThreadTranscript({
          prepared: prepared.value,
          threadId: input.threadId,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
        });
      }),
    }),
    v2: {
      dispatchCommand: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:orchestration-v2:dispatch-command",
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      }),
      shell: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:shell",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      }),
      thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        idleTtlMs: 0,
      }),
      // One expanded command row's output. A running command's subscription ends
      // as soon as its row closes, so hidden rows receive nothing; a finished
      // command's final output stays cached so reopening it does not refetch.
      commandOutput: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:command-output",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
        idleTtlMs: 0,
        completeWhen: (view: CommandOutputView) => !view.running,
        completedTtlMs: 5 * 60_000,
        // `scan` emits its seed first; skipping it keeps the row "loading" until the first frame.
        transform: (frames) =>
          frames.pipe(
            Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame),
            Stream.filter((view) => view !== EMPTY_COMMAND_OUTPUT),
          ),
      }),
      // The open thread's predicted next prompt, while its composer is mounted.
      promptSuggestion: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:prompt-suggestion",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion,
        idleTtlMs: 0,
      }),
    },
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
      ...onCheckpointDiffAnswer,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    // Mounted only while a subagent inspector is open; running children change between opens.
    nativeChildWork: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:native-child-work",
      tag: ORCHESTRATION_V2_WS_METHODS.getNativeChildWork,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    stopWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:stop-workflow",
      tag: ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
    }),
    forceStopThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:force-stop-thread",
      tag: ORCHESTRATION_V2_WS_METHODS.forceStopThread,
    }),
    turnItem: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: OrchestrationV2GetTurnItemInput;
    }) =>
      target.input.revision === undefined || target.input.revision === "live"
        ? liveTurnItem(target)
        : settledTurnItem(target),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
      ...onCheckpointDiffAnswer,
    }),
    threadFind: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-find",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThread,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    threadFindProgressive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-find-progressive",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
      completeWhen: (result) => result.complete !== false,
      idleTtlMs: 0,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreads,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
      // The shell reports archiving a thread, and deleting or changing an archived one, as a removal,
      // and replaces `removedAt` on each one.
      refreshTrigger: ({ environmentId }) => {
        if (shellState === undefined) return undefined;
        const state = shellState(environmentId);
        return Atom.make((get) => get(state).removedAt);
      },
    }),
    threadFamily: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-family-for-delete",
      tag: ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    // Read right before deleting a worktree, so never served from cache.
    worktreeThreadIds: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:worktree-thread-ids",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}
