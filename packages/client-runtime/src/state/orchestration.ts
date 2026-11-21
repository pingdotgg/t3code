import { msg } from "gt-i18n";
import { translatableMessage } from "../errors/translatable.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type OrchestrationV2ThreadLinkMetadata,
  type OrchestrationGetTurnDiffResult,
  type OrchestrationV2GetTurnItemInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
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
const THREAD_LINK_METADATA_IDLE_TTL_MS = 5 * 60_000;
const THREAD_LINK_METADATA_CACHE_LIMIT = 2048;

type ThreadLinkMetadataMap = Readonly<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>>;
type ThreadLinkMetadataError = Effect.Error<ReturnType<typeof fetchThreadLinkMetadataChunked>>;

interface CachedThreadLinkMetadata {
  readonly value: OrchestrationV2ThreadLinkMetadata | null;
  readonly expiresAt: number;
  readonly shellGeneration: number;
  readonly removedAtSeq: number;
}

class ThreadLinkMetadataRequest extends Request.Class<
  {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly session: RpcSession.RpcSession;
    readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    readonly registry: AtomRegistry.AtomRegistry;
  },
  ReadonlyMap<ThreadId, OrchestrationV2ThreadLinkMetadata>,
  ThreadLinkMetadataError
> {}

const metadataMapToRecord = (
  entries: ReadonlyMap<ThreadId, OrchestrationV2ThreadLinkMetadata>,
): ThreadLinkMetadataMap => Object.fromEntries(entries) as ThreadLinkMetadataMap;

// Runs inside orchestration.fetchThreadLinkMetadataChunked, which owns the span.
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

const fetchThreadLinkMetadataChunked = Effect.fn("orchestration.fetchThreadLinkMetadataChunked")(
  function* (
    supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
    session: RpcSession.RpcSession,
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    const merged = new Map<ThreadId, OrchestrationV2ThreadLinkMetadata>();
    if (threadIds.length === 0) return merged;
    yield* assertSessionActive(supervisor, session);
    const config = yield* session.initialConfig;
    for (let offset = 0; offset < threadIds.length; offset += THREAD_LINK_METADATA_CHUNK_SIZE) {
      yield* assertSessionActive(supervisor, session);
      const chunk = threadIds.slice(offset, offset + THREAD_LINK_METADATA_CHUNK_SIZE);
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
        const titles = yield* requestInSession(
          session,
          ORCHESTRATION_V2_WS_METHODS.getThreadTitles,
          { threadIds: chunk },
        ).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        for (const threadId of chunk) {
          if (!Object.hasOwn(titles, threadId)) continue;
          const title = titles[threadId];
          if (title !== undefined) merged.set(threadId, { title, projectId: null });
        }
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
  // Keyed by session so a reconnect never serves the previous session's answers.
  const threadLinkMetadataCache = new WeakMap<
    RpcSession.RpcSession,
    Map<ThreadId, CachedThreadLinkMetadata>
  >();
  const readShellVersion = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    if (shellState === undefined) return { generation: 0, removedAt: undefined };
    const { generation, removedAt } = registry.get(shellState(environmentId));
    return { generation, removedAt };
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
    entries.delete(threadId);
    if (
      cached.expiresAt <= now ||
      cached.shellGeneration !== generation ||
      cached.removedAtSeq !== removedAtSeq
    ) {
      return undefined;
    }
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
      const uniqueIds = [...new Set(entries.flatMap((entry) => entry.request.threadIds))];
      const before = readShellVersion(registry, environmentId);
      const fetched = yield* fetchThreadLinkMetadataChunked(supervisor, session, uniqueIds);
      const now = yield* Clock.currentTimeMillis;
      const after = readShellVersion(registry, environmentId);
      // A removal or snapshot that landed while the request was in flight makes its answer stale.
      if (before.generation === after.generation) {
        for (const threadId of uniqueIds) {
          const removedAtSeq = before.removedAt?.get(threadId) ?? -1;
          if ((after.removedAt?.get(threadId) ?? -1) !== removedAtSeq) continue;
          rememberThreadLinkMetadata(session, threadId, {
            value: fetched.get(threadId) ?? null,
            expiresAt: now + THREAD_LINK_METADATA_STALE_TIME_MS,
            shellGeneration: before.generation,
            removedAtSeq,
          });
        }
      }
      for (const entry of entries) {
        const subset = new Map<ThreadId, OrchestrationV2ThreadLinkMetadata>();
        for (const threadId of entry.request.threadIds) {
          const value = fetched.get(threadId);
          if (value !== undefined) subset.set(threadId, value);
        }
        entry.completeUnsafe(Exit.succeed(subset));
      }
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
      // Let the per-thread 60 s cache govern freshness so subset keys never stack a second window.
      staleTimeMs: 0,
      idleTtlMs: THREAD_LINK_METADATA_IDLE_TTL_MS,
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
        const now = yield* Clock.currentTimeMillis;
        const { generation, removedAt } = readShellVersion(
          registry,
          supervisor.target.environmentId,
        );
        const resolved = new Map<ThreadId, OrchestrationV2ThreadLinkMetadata>();
        const uncached: Array<ThreadId> = [];
        const seenUncached = new Set<ThreadId>();
        for (const threadId of input.threadIds) {
          const cached = getCachedThreadLinkMetadata(
            session,
            threadId,
            now,
            generation,
            removedAt?.get(threadId) ?? -1,
          );
          if (cached !== undefined) {
            if (cached.value !== null) resolved.set(threadId, cached.value);
          } else if (!seenUncached.has(threadId)) {
            seenUncached.add(threadId);
            uncached.push(threadId);
          }
        }
        if (uncached.length === 0) return metadataMapToRecord(resolved);
        if (Option.isNone(previous) && resolved.size > 0) {
          yield* emit(metadataMapToRecord(resolved));
        }
        const fetched = yield* Effect.request(
          new ThreadLinkMetadataRequest({
            threadIds: uncached,
            session,
            supervisor,
            registry,
          }),
          threadLinkMetadataResolver,
        );
        for (const [threadId, value] of fetched) {
          resolved.set(threadId, value);
        }
        return metadataMapToRecord(resolved);
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
