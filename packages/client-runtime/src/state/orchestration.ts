import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type OrchestrationV2ThreadLinkMetadata,
  type OrchestrationGetTurnDiffResult,
  type OrchestrationV2GetTurnItemInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

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
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  options: {
    /** Re-checks `threadTitles` when one of their threads leaves the shell. */
    readonly shellState?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<Pick<EnvironmentShellState, "removedAt">>;
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
      const { removedAt } = get(state);
      return Math.max(-1, ...input.threadIds.map((threadId) => removedAt.get(threadId) ?? -1));
    });
  };
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
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshTrigger: refreshThreadLookup,
      execute: Effect.fn("orchestration.threadLinkMetadata")(function* (input: {
        readonly threadIds: ReadonlyArray<ThreadId>;
      }) {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(session)) {
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "The environment has no session.",
          });
        }
        const config = yield* session.value.initialConfig;
        if (config.threadLinkMetadata === true) {
          return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata, input);
        }
        const titles = yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadTitles, input);
        return Object.fromEntries(
          Object.entries(titles).map(([id, title]) => [
            id,
            { title, projectId: null } satisfies OrchestrationV2ThreadLinkMetadata,
          ]),
        );
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
            message: "The source environment is not connected.",
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
    threadInsights: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-insights",
      tag: ORCHESTRATION_V2_WS_METHODS.getThreadInsights,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
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
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
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
