// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { claudeTaskOutputRoot } from "./ClaudeTaskOutputTail.ts";

import {
  claudeLedgerDelta,
  claudeModelLedger,
  claudeReportedContextWindows,
} from "../../provider/ClaudeTurnTokenUsage.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import * as Stream from "effect/Stream";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionApprovals.ts";
import { installApprovals } from "./claudeSessionApprovals.ts";
import { CLAUDE_CODE_PRESET_TOOLS } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeBackgroundWorkBlocksQueryReplacementError } from "./ClaudeQueryRunnerTypes.ts";
import { canApplyClaudeSelectionLive } from "./ClaudeQueryOptions.ts";
import { claudeEffectiveQueryPolicyKey } from "./ClaudeRuntimePolicy.ts";
import { claudeLiveSelectionFlagSettings } from "./ClaudeQueryOptions.ts";
import { claudeMcpQueryOverrides } from "./ClaudeQueryLaunchArgs.ts";
import { claudeQueryEnvironment } from "./ClaudeQueryOptions.ts";
import { claudeSdkLaunchArgSettings } from "./ClaudeRuntimePolicy.ts";
import { getNativeConversationHeadId } from "./ClaudeProviderMessages.ts";
import { isClaudeProviderContinuationTurn } from "./ClaudeApprovals.ts";
import { makeClaudeQueryOptions } from "./ClaudeQueryOptions.ts";
import { readClaudeAppendSystemPromptFile } from "./ClaudeQueryLaunchArgs.ts";
import { readClaudeLaunchArgSettings } from "./ClaudeQueryLaunchArgs.ts";
import { sandboxPolicyKindForClaudeRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeQueryStreamExit } from "./ClaudeQueryRunnerTypes.ts";

export type Deps = PrevDeps & ReturnType<typeof installApprovals>;

export const installQuery = (s: Deps) => {
  const {
    adapterOptions,
    attachmentsDir,
    fileSystem,
    path,
    queryRunner,
    mcpSessions,
    reportedContextWindows,
    hostPlatform,
    resolveSubagentPromptCacheTtl,
    resolveToolSearchOverride,
    input,
  } = s.env;
  const {
    sessionScope,
    activeTurn,
    sdkMessageLock,
    queryContext,
    resultLedgerUsage,
    resultsReportingNewContextWindow,
    queryPolicyForTurn,
    openedNativeThreads,
    sessionSubagentsByTaskId,
    clearWakeStateForNativeThread,
    resetBackgroundTaskStateForNativeThreadProcess,
    endSubagentCallsOfClosedQuery,
    endSubagentsOfReplacedQuery,
    finalizeActiveTurnAfterQueryExit,
    releaseHeldRootFrames,
    handleSdkMessage,
    canUseTool,
    onElicitation,
    onUserDialog,
    liveProcessRunsBackgroundWork,
  } = s;
  const openQuery = Effect.fnUntraced(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    nativeThreadId: string,
  ) {
    const queryPolicy = yield* queryPolicyForTurn(turnInput);
    const mcpSession = yield* mcpSessions.read(turnInput.threadId);
    const mcpOverrides = claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox:
        sandboxPolicyKindForClaudeRuntimePolicy(turnInput.runtimePolicy) === "readOnly",
      ...(queryPolicy.allowedTools === undefined ? {} : { allowedTools: queryPolicy.allowedTools }),
    });
    const queryPolicyKey = claudeEffectiveQueryPolicyKey(queryPolicy, mcpOverrides);
    const compiledSelection = compileClaudeModelSelection(turnInput.modelSelection);
    const resumeSessionAt = yield* getNativeConversationHeadId(turnInput.providerThread);
    const existing = yield* Ref.get(queryContext);
    // Continuations drain existing output without prompting; retain the live process regardless of selection.
    if (
      existing !== null &&
      existing.nativeThreadId === nativeThreadId &&
      !existing.stopping &&
      isClaudeProviderContinuationTurn(turnInput)
    ) {
      return existing;
    }
    if (
      existing !== null &&
      existing.nativeThreadId === nativeThreadId &&
      existing.queryPolicyKey === queryPolicyKey &&
      !existing.stopping &&
      existing.selection.queryIdentity !== compiledSelection.queryIdentity &&
      canApplyClaudeSelectionLive(existing.selection, compiledSelection) &&
      (existing.selection.apiModelId === compiledSelection.apiModelId ||
        existing.openedPermissionMode === queryPolicy.permissionMode)
    ) {
      const live = existing;
      // Preserve launcher-selected models unless the model changed or a failed update left it unknown.
      yield* (
        live.selection.queryIdentity === "" ||
        live.selection.apiModelId !== compiledSelection.apiModelId
          ? live.query.setModel(compiledSelection.apiModelId)
          : Effect.void
      ).pipe(
        Effect.andThen(
          live.query.applyFlagSettings(claudeLiveSelectionFlagSettings(compiledSelection)),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            live.selection = { ...live.selection, queryIdentity: "" };
          }),
        ),
      );
      live.selection = compiledSelection;
    }
    if (
      existing !== null &&
      existing.nativeThreadId === nativeThreadId &&
      existing.queryPolicyKey === queryPolicyKey &&
      !existing.stopping &&
      existing.selection.queryIdentity === compiledSelection.queryIdentity
    ) {
      // A denied ExitPlanMode leaves Claude in plan mode. Restore only from plan:
      // Auto/default may reflect a policy restriction that forbids restoring bypass.
      if (existing.permissionMode === "plan" && existing.openedPermissionMode !== "plan") {
        existing.permissionMode = yield* existing.query
          .setPermissionMode(existing.openedPermissionMode)
          .pipe(
            Effect.as(existing.openedPermissionMode),
            Effect.catchTags({
              ClaudeAgentSdkQueryRunnerError: (error) =>
                existing.openedPermissionMode === "bypassPermissions"
                  ? existing.query.setPermissionMode("default").pipe(Effect.as("default" as const))
                  : Effect.fail(error),
            }),
          );
      }
      return existing;
    }

    // Replacing this thread's process kills its background work, even with a new native identity.
    if (
      existing !== null &&
      (existing.nativeThreadId === nativeThreadId ||
        existing.lastTurn?.input.threadId === turnInput.threadId) &&
      !existing.stopping &&
      (yield* liveProcessRunsBackgroundWork(existing))
    ) {
      return yield* new ClaudeBackgroundWorkBlocksQueryReplacementError();
    }

    // Read before closing the live process so a bad path leaves it running.
    const appendSystemPromptFileText = yield* readClaudeAppendSystemPromptFile({
      settings: adapterOptions.settings,
      cwd: turnInput.runtimePolicy.cwd,
      fileSystem,
      path,
    });
    const launchArgSettings = yield* readClaudeLaunchArgSettings({
      settings: adapterOptions.settings,
      cwd: turnInput.runtimePolicy.cwd,
      fileSystem,
      path,
    });
    const closedExistingNativeThreadId = existing !== null ? existing.nativeThreadId : null;
    if (existing !== null) {
      yield* existing.query.close.pipe(Effect.ignore);
      if (existing.nativeThreadId !== nativeThreadId) {
        yield* clearWakeStateForNativeThread(existing.nativeThreadId);
        yield* resetBackgroundTaskStateForNativeThreadProcess(existing.nativeThreadId, {
          status: "idle",
        });
      }
    }

    const openedWithResume = (yield* Ref.get(openedNativeThreads)).has(nativeThreadId);
    // Idle release loses openedNativeThreads; persisted turns still require resume to avoid "already in use".
    const hasPersistedProviderTurn =
      turnInput.nativeThreadHasTurns ?? turnInput.providerTurnOrdinal > 1;
    const shouldResume =
      resumeSessionAt !== undefined || openedWithResume || hasPersistedProviderTurn;
    const toolSearchOverride = yield* resolveToolSearchOverride(
      turnInput.runtimePolicy.cwd,
      launchArgSettings,
    );
    const queryOptions = makeClaudeQueryOptions({
      modelSelection: turnInput.modelSelection,
      nativeThreadId,
      title: turnInput.appThread.title,
      resume: shouldResume,
      ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
      cwd: turnInput.runtimePolicy.cwd,
      attachmentsDir,
      settings: adapterOptions.settings,
      ...(launchArgSettings === undefined
        ? {}
        : { sdkSettings: claudeSdkLaunchArgSettings(launchArgSettings) }),
      environment: claudeQueryEnvironment(
        adapterOptions.environment,
        turnInput.appThread,
        turnInput.appThread.lineage.relationshipToParent === "subagent"
          ? yield* resolveSubagentPromptCacheTtl(turnInput.runtimePolicy.cwd)
          : undefined,
      ),
      tools: queryPolicy.tools ?? CLAUDE_CODE_PRESET_TOOLS,
      ...(mcpOverrides.allowedTools === undefined
        ? {}
        : { allowedTools: mcpOverrides.allowedTools }),
      ...(mcpOverrides.mcpServers === undefined ? {} : { mcpServers: mcpOverrides.mcpServers }),
      deviceToolsAvailable: mcpSession?.capabilities?.has("device") === true,
      permissionMode: queryPolicy.permissionMode,
      ...(queryPolicy.allowDangerouslySkipPermissions === undefined
        ? {}
        : {
            allowDangerouslySkipPermissions: queryPolicy.allowDangerouslySkipPermissions,
          }),
      canUseTool,
      onUserDialog,
      onElicitation,
      supportedDialogKinds: ["resume_return"],
      ...(appendSystemPromptFileText === undefined ? {} : { appendSystemPromptFileText }),
      ...(toolSearchOverride === undefined ? {} : { toolSearchOverride }),
    });
    const resolvedTurnCwd = yield* fileSystem
      .realPath(turnInput.runtimePolicy.cwd ?? ".")
      .pipe(Effect.orElseSucceed(() => turnInput.runtimePolicy.cwd));
    const querySession = yield* queryRunner
      .open({
        threadId: turnInput.threadId,
        providerSessionId: input.providerSessionId,
        options: queryOptions,
      })
      .pipe(
        Effect.onError(() =>
          closedExistingNativeThreadId === nativeThreadId
            ? Effect.gen(function* () {
                yield* clearWakeStateForNativeThread(nativeThreadId);
                yield* resetBackgroundTaskStateForNativeThreadProcess(nativeThreadId, {
                  status: "idle",
                });
              })
            : Effect.void,
        ),
      );
    // Mark only successful opens; retries must not resume sessions that failed to create.
    yield* Ref.update(openedNativeThreads, (current) => {
      if (current.has(nativeThreadId)) {
        return current;
      }
      const updated = new Set(current);
      updated.add(nativeThreadId);
      return updated;
    });
    yield* resetBackgroundTaskStateForNativeThreadProcess(nativeThreadId, {
      status: "active",
    });
    const closed = yield* Deferred.make<void, never>();
    const context: ClaudeLiveQueryContext = {
      queryPolicy,
      nativeThreadId,
      query: querySession,
      queryPolicyKey,
      selection: compiledSelection,
      closed,
      lastTurn: null,
      promptEchoMode: "unknown",
      openedPermissionMode: queryOptions.permissionMode,
      receivedInit: false,
      permissionMode: queryOptions.permissionMode,
      stopping: false,
      handedOffSubagents: new Set(),
      subagentsFromEarlierProcesses: new Set(
        [...(yield* Ref.get(sessionSubagentsByTaskId)).values()].filter(
          (subagent) => subagent.task.status === "running",
        ),
      ),
      modelLedger: new Map(),
      taskOutputRoot: claudeTaskOutputRoot(
        adapterOptions.environment,
        path,
        resolvedTurnCwd,
        hostPlatform,
      ),
    };
    // One step, so the replaced process cannot exit between the install and the handoff.
    yield* Ref.update(queryContext, (replaced) => {
      if (replaced !== null) {
        replaced.handedOffSubagents = new Set(
          [...context.subagentsFromEarlierProcesses].filter(
            (subagent) => !replaced.subagentsFromEarlierProcesses.has(subagent),
          ),
        );
      }
      return context;
    });
    yield* querySession.messages.pipe(
      Stream.runForEach((message) =>
        sdkMessageLock.withPermits(1)(
          Effect.suspend(() => {
            if (message.type === "system" && message.subtype === "init" && !context.receivedInit) {
              context.openedPermissionMode = message.permissionMode ?? context.openedPermissionMode;
              context.receivedInit = true;
            }
            if (
              message.type === "system" &&
              (message.subtype === "init" || message.subtype === "status") &&
              message.permissionMode !== undefined
            ) {
              context.permissionMode = message.permissionMode;
            }
            if (message.type === "result") {
              const ledger = claudeModelLedger(message.modelUsage);
              const growth = claudeLedgerDelta(context.modelLedger, ledger);
              if (growth !== undefined) resultLedgerUsage.set(message, growth);
              // A ledger that went backwards cannot anchor the next turn's growth.
              context.modelLedger =
                growth === undefined && context.modelLedger !== undefined ? undefined : ledger;
              for (const [model, window] of claudeReportedContextWindows(message.modelUsage)) {
                if (reportedContextWindows.get(model) === window) continue;
                reportedContextWindows.set(model, window);
                resultsReportingNewContextWindow.add(message);
              }
            }
            return handleSdkMessage({ query: querySession, message });
          }),
        ),
      ),
      Effect.exit,
      Effect.flatMap(
        Effect.fnUntraced(function* (exit: ClaudeQueryStreamExit) {
          const heldContext = yield* Ref.get(activeTurn);
          if (
            (yield* Ref.get(queryContext))?.query === querySession &&
            heldContext !== null &&
            heldContext.heldRootFrames.length > 0
          ) {
            yield* releaseHeldRootFrames(heldContext);
          }
          const ownsLiveQuery = yield* Ref.modify(queryContext, (current) =>
            current?.query === querySession ? [true, null] : [false, current],
          );
          if (ownsLiveQuery) {
            yield* finalizeActiveTurnAfterQueryExit(
              context,
              exit._tag === "Failure" ? exit.cause : undefined,
            );
            yield* endSubagentCallsOfClosedQuery(
              context.nativeThreadId,
              context.stopping ? "interrupted" : "failed",
            );
          } else {
            yield* endSubagentsOfReplacedQuery(context);
          }
        }),
      ),
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkIn(sessionScope),
    );
    return context;
  });

  return {
    openQuery,
  };
};
