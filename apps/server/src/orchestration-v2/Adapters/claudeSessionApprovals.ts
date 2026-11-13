// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  Options as ClaudeQueryOptions,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeUtil from "node:util";

import {
  CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER,
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";

import { resolveIdleCompaction } from "@t3tools/contracts";
import type { ProviderUserInputAnswers } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";
import type { Deps as PrevDeps } from "./claudeSessionFrameTail.ts";
import { installFrameTail } from "./claudeSessionFrameTail.ts";
import { CLAUDE_MCP_ELICITATION_OPTIONS } from "./ClaudeApprovals.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { awaitClaudeApprovalDecision } from "./ClaudeApprovals.ts";
import { awaitClaudeUserInputAnswers } from "./ClaudeApprovals.ts";
import { claudeApprovalPresentation } from "./ClaudeApprovals.ts";
import { claudeMcpElicitationAcceptance } from "./ClaudeApprovals.ts";
import { claudeNativeToolInputFromRecord } from "./ClaudeToolClassification.ts";
import { claudeProposedPlan } from "./ClaudeSessionTypes.ts";
import { claudeSdkUserInputAnswers } from "./ClaudeSessionTypes.ts";
import { claudeUserInputQuestions } from "./ClaudeSessionTypes.ts";
import { inputRecordValue } from "./ClaudeToolClassification.ts";
import { permissionResultFromDecision } from "./ClaudeApprovals.ts";
import { providerRequestKindFromClaudeTool } from "./ClaudeToolClassification.ts";
import { rememberClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";
import { requiresClaudeApproval } from "./ClaudeRuntimePolicy.ts";
import { summarizeClaudeToolRequest } from "./ClaudeToolClassification.ts";
import type { ClaudeApprovalResponse } from "./ClaudeSessionTypes.ts";

export type Deps = PrevDeps & ReturnType<typeof installFrameTail>;

export const installApprovals = (s: Deps) => {
  const { adapterOptions, serverSettings, subagentModelCatalog } = s.env;
  const {
    now,
    activeTurn,
    queryContext,
    pendingRuntimeRequests,
    pendingSubagentLaunchesByToolUseId,
    heldProposedPlansByToolUseId,
    runPromise,
    emitProviderEvent,
    emitClaudePlanProjection,
    ensureToolCallStarted,
    startToolCall,
    buildApprovalRequestArtifacts,
    cancelWithdrawnRequest,
    heldToolUseIds,
    releaseHeldRootFrames,
  } = s;
  const canUseToolEffect = Effect.fn("ClaudeAdapterV2.canUseTool")(function* (
    toolName: Parameters<CanUseTool>[0],
    toolInput: Parameters<CanUseTool>[1],
    callbackOptions: Parameters<CanUseTool>[2],
    options?: { readonly startToolCall?: boolean },
  ) {
    const context = yield* Ref.get(activeTurn);
    if (context === null) {
      return {
        behavior: "deny",
        message: "Claude V2 adapter has no active turn for this tool request.",
        toolUseID: callbackOptions.toolUseID,
      } satisfies PermissionResult;
    }

    const nativeRequestId = callbackOptions.toolUseID;
    const nativeToolInput = claudeNativeToolInputFromRecord(toolInput);
    const heldForEcho = context.heldRootFrames.length > 0;
    const startToolCall = toolName !== "Agent" && options?.startToolCall !== false;
    if (toolName === "Agent") {
      rememberClaudeSubagentLaunch(
        subagentModelCatalog,
        context,
        pendingSubagentLaunchesByToolUseId,
        nativeRequestId,
        nativeToolInput,
        null,
      );
    } else if (startToolCall && !heldForEcho) {
      yield* ensureToolCallStarted({
        context,
        nativeItemId: nativeRequestId,
        toolName,
        toolInput: nativeToolInput,
        parentToolUseId: null,
      });
    }

    if (
      heldForEcho &&
      toolName !== "ExitPlanMode" &&
      (toolName === "AskUserQuestion" || requiresClaudeApproval(context))
    ) {
      // The SDK blocks prompt echoes on permission answers; release held output except for ExitPlanMode.
      yield* releaseHeldRootFrames(context);
      if (startToolCall) {
        yield* ensureToolCallStarted({
          context,
          nativeItemId: nativeRequestId,
          toolName,
          toolInput: nativeToolInput,
          parentToolUseId: null,
        });
      }
    }

    if (toolName === "AskUserQuestion") {
      const questions = claudeUserInputQuestions(nativeToolInput);
      const artifacts = yield* buildApprovalRequestArtifacts({
        context,
        nativeItemId: nativeRequestId,
        nativeRequestId,
        // No tool node exists for a control request to hang under.
        ...(options?.startToolCall === false ? { parentNodeId: context.input.rootNodeId } : {}),
        requestKind: "user_input",
        questions,
      });
      const answers = yield* Deferred.make<ProviderUserInputAnswers, never>();
      yield* Ref.update(pendingRuntimeRequests, (current) => {
        const updated = new Map(current);
        updated.set(String(artifacts.request.id), {
          type: "user_input",
          answers,
        });
        return updated;
      });
      yield* Effect.all(
        [
          emitProviderEvent({
            type: "node.updated",
            driver: CLAUDE_PROVIDER,
            node: artifacts.node,
          }),
          emitProviderEvent({
            type: "runtime_request.updated",
            driver: CLAUDE_PROVIDER,
            runtimeRequest: artifacts.request,
          }),
          emitProviderEvent({
            type: "turn_item.updated",
            driver: CLAUDE_PROVIDER,
            turnItem: artifacts.turnItem,
          }),
        ],
        { concurrency: 1 },
      );
      const resolvedAnswers = yield* awaitClaudeUserInputAnswers(
        answers,
        callbackOptions.signal,
      ).pipe(
        Effect.ensuring(
          Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.delete(String(artifacts.request.id));
            return updated;
          }),
        ),
      );
      if (!(yield* Deferred.isDone(answers))) yield* cancelWithdrawnRequest(artifacts);
      return callbackOptions.signal.aborted
        ? ({
            behavior: "deny",
            message: "User cancelled tool execution.",
          } satisfies PermissionResult)
        : ({
            behavior: "allow",
            updatedInput: {
              questions: toolInput.questions,
              answers: claudeSdkUserInputAnswers(resolvedAnswers),
            },
            toolUseID: callbackOptions.toolUseID,
          } satisfies PermissionResult);
    }

    if (toolName === "ExitPlanMode") {
      const markdown = claudeProposedPlan(nativeToolInput);
      if (markdown !== null && heldToolUseIds(context).has(nativeRequestId)) {
        heldProposedPlansByToolUseId.set(nativeRequestId, markdown);
      } else if (markdown !== null) {
        yield* emitClaudePlanProjection({
          context,
          nativeItemId: nativeRequestId,
          kind: "proposed_plan",
          markdown,
        });
      }
      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
        toolUseID: callbackOptions.toolUseID,
      } satisfies PermissionResult;
    }

    if (
      context.input.runtimePolicy.interactionMode === "plan" &&
      context.input.runtimePolicy.approvalPolicy === "never"
    ) {
      return {
        behavior: "deny",
        message:
          "This tool requires approval in Plan mode, but approvals are disabled for this thread.",
        toolUseID: callbackOptions.toolUseID,
      } satisfies PermissionResult;
    }

    if (!requiresClaudeApproval(context)) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        toolUseID: callbackOptions.toolUseID,
      } satisfies PermissionResult;
    }

    const activePermissionMode =
      (yield* Ref.get(queryContext))?.permissionMode ?? context.queryPolicy.permissionMode;
    const safetyReason = NodeUtil.stripVTControlCharacters(
      callbackOptions.decisionReason ?? "",
    ).trim();
    // The SDK omits the CLI's dangerousRemoval discriminator, so match its removal warnings.
    if (
      toolName === "Bash" &&
      activePermissionMode === "bypassPermissions" &&
      callbackOptions.matchedAskRule === undefined &&
      (/^Dangerous rm(?:dir)?\b/i.test(safetyReason) ||
        safetyReason === "This shell -c script runs rm and could not be checked" ||
        safetyReason === "A permission rule denies a command in this shell -c script")
    ) {
      return {
        behavior: "deny",
        message: `Claude Code's removal safety check denied this command; the user did not reject it. The command did not run. Do not bypass the check by splitting the removal, putting it in a script, or using another tool or shell. If the warning below supplies a safe rewrite, use it and let the same check evaluate it. Otherwise continue the rest of the task without the removal and tell the user what you needed to delete and why. Warning: ${safetyReason}`,
        toolUseID: callbackOptions.toolUseID,
      } satisfies PermissionResult;
    }

    const requestKind = providerRequestKindFromClaudeTool(toolName);
    // The user approves the command itself; Claude's title and description only summarize it.
    const command = inputRecordValue(nativeToolInput, "command");
    const prompt =
      (typeof command === "string" && command.trim() !== "" ? command : undefined) ??
      callbackOptions.title ??
      callbackOptions.description ??
      callbackOptions.decisionReason ??
      summarizeClaudeToolRequest(toolName, nativeToolInput);
    const artifacts = yield* buildApprovalRequestArtifacts({
      context,
      nativeItemId: nativeRequestId,
      nativeRequestId,
      requestKind,
      prompt,
      presentation: claudeApprovalPresentation({
        permissionMode: context.queryPolicy.permissionMode,
        prompt,
        callbackOptions,
      }),
    });
    const decision = yield* Deferred.make<ClaudeApprovalResponse, never>();
    yield* Ref.update(pendingRuntimeRequests, (current) => {
      const updated = new Map(current);
      updated.set(String(artifacts.request.id), {
        type: "approval",
        requestKind,
        decision,
      });
      return updated;
    });
    yield* Effect.all(
      [
        emitProviderEvent({
          type: "node.updated",
          driver: CLAUDE_PROVIDER,
          node: artifacts.node,
        }),
        emitProviderEvent({
          type: "runtime_request.updated",
          driver: CLAUDE_PROVIDER,
          runtimeRequest: artifacts.request,
        }),
        emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: artifacts.turnItem,
        }),
      ],
      { concurrency: 1 },
    );

    const resolvedDecision = yield* awaitClaudeApprovalDecision(
      decision,
      callbackOptions.signal,
    ).pipe(
      Effect.ensuring(
        Ref.update(pendingRuntimeRequests, (current) => {
          const updated = new Map(current);
          updated.delete(String(artifacts.request.id));
          return updated;
        }),
      ),
    );
    if (!(yield* Deferred.isDone(decision))) yield* cancelWithdrawnRequest(artifacts);

    return permissionResultFromDecision({
      toolName,
      ...resolvedDecision,
      toolInput,
      toolUseID: callbackOptions.toolUseID,
      managedCeiling: context.input.runtimePolicy.maxRuntimeMode !== undefined,
      ...(callbackOptions.suggestions === undefined
        ? {}
        : { suggestions: callbackOptions.suggestions }),
    });
  });

  const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
    runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

  const onElicitation: NonNullable<ClaudeQueryOptions["onElicitation"]> = (
    request,
    callbackOptions,
  ) => runPromise(onElicitationEffect(request, callbackOptions));

  const onElicitationEffect = Effect.fn("ClaudeAdapterV2.onElicitation")(function* (
    request: ElicitationRequest,
    callbackOptions: Parameters<NonNullable<ClaudeQueryOptions["onElicitation"]>>[1],
  ) {
    if (callbackOptions.signal.aborted) return { action: "cancel" } satisfies ElicitationResult;
    const acceptance = claudeMcpElicitationAcceptance(request);
    const context = yield* Ref.get(activeTurn);
    if (acceptance === undefined || context === null) {
      yield* Effect.logWarning("Declined an MCP elicitation the approval card cannot answer.", {
        serverName: request.serverName,
        mode: request.mode,
        activeTurn: context !== null,
      });
      return { action: "decline" } satisfies ElicitationResult;
    }
    // The CLI waits on this answer, so a turn held for its prompt echo
    // must show its output now, as canUseTool does.
    if (context.heldRootFrames.length > 0) {
      yield* releaseHeldRootFrames(context);
    }

    // The SDK's requestId names this control request; T3 allocates its own
    // runtime request id from it.
    const nativeRequestId = `mcp-elicitation:${callbackOptions.requestId}`;
    const artifacts = yield* buildApprovalRequestArtifacts({
      context,
      nativeItemId: nativeRequestId,
      nativeRequestId,
      requestKind: "mcp-elicitation",
      prompt: request.message,
      appName: request.displayName ?? request.title ?? request.serverName,
      options: CLAUDE_MCP_ELICITATION_OPTIONS,
    });
    const decision = yield* Deferred.make<ClaudeApprovalResponse>();
    yield* Ref.update(pendingRuntimeRequests, (current) => {
      const updated = new Map(current);
      updated.set(String(artifacts.request.id), {
        type: "approval",
        requestKind: "mcp-elicitation",
        decision,
      });
      return updated;
    });
    yield* Effect.all(
      [
        emitProviderEvent({
          type: "node.updated",
          driver: CLAUDE_PROVIDER,
          node: artifacts.node,
        }),
        emitProviderEvent({
          type: "runtime_request.updated",
          driver: CLAUDE_PROVIDER,
          runtimeRequest: artifacts.request,
        }),
        emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: artifacts.turnItem,
        }),
      ],
      { concurrency: 1 },
    );

    // Closing the query aborts the signal, so a stopped session settles
    // this as cancel and a late response finds no pending request.
    const { decision: resolved } = yield* awaitClaudeApprovalDecision(
      decision,
      callbackOptions.signal,
    ).pipe(
      Effect.ensuring(
        Ref.update(pendingRuntimeRequests, (current) => {
          const updated = new Map(current);
          updated.delete(String(artifacts.request.id));
          return updated;
        }),
      ),
    );
    if (resolved === "cancel" && callbackOptions.signal.aborted) {
      const now = yield* DateTime.now;
      yield* emitProviderEvent({
        type: "node.updated",
        driver: CLAUDE_PROVIDER,
        node: { ...artifacts.node, status: "cancelled", completedAt: now },
      });
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: {
          ...artifacts.turnItem,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* emitProviderEvent({
        type: "runtime_request.updated",
        driver: CLAUDE_PROVIDER,
        runtimeRequest: { ...artifacts.request, status: "cancelled", resolvedAt: now },
      });
    }
    // Never null: the SDK reads null as answered out of band and leaves
    // the server waiting. Every accept is one-time; no grant is offered.
    return resolved === "accept"
      ? acceptance
      : ({
          action: resolved === "cancel" ? "cancel" : "decline",
        } satisfies ElicitationResult);
  });

  const onUserDialog: NonNullable<ClaudeQueryOptions["onUserDialog"]> = (
    request,
    callbackOptions,
  ) =>
    runPromise(
      Effect.gen(function* () {
        if (request.dialogKind !== "resume_return") {
          return { behavior: "cancelled" as const };
        }
        const idleCompaction = Option.isSome(serverSettings)
          ? yield* serverSettings.value.getSettings.pipe(
              Effect.map((settings) => resolveIdleCompaction(settings, adapterOptions.instanceId)),
              Effect.orElseSucceed(() => adapterOptions.settings.idleCompaction),
            )
          : adapterOptions.settings.idleCompaction;
        if (idleCompaction === "off") {
          return { behavior: "completed" as const, result: "continue" as const };
        }
        const ageMinutes =
          typeof request.payload.sessionAgeMinutes === "number" &&
          Number.isFinite(request.payload.sessionAgeMinutes)
            ? Math.max(0, Math.floor(request.payload.sessionAgeMinutes))
            : 0;
        const estimatedTokens =
          typeof request.payload.estimatedTokens === "number" &&
          Number.isFinite(request.payload.estimatedTokens)
            ? Math.max(0, Math.floor(request.payload.estimatedTokens))
            : 0;
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes,
          estimatedTokens,
        });
        const result = yield* canUseToolEffect(
          "AskUserQuestion",
          {
            questions: [
              {
                header: "Resume session",
                question,
                options: [
                  {
                    label: CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER,
                    description: "Resume with a summary and use fewer tokens.",
                  },
                  {
                    label: "Keep full history",
                    description: "Resume without changing the conversation.",
                  },
                  {
                    label: CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
                    description: "Keep full history and skip future resume prompts.",
                  },
                ],
                multiSelect: false,
              },
            ],
          },
          {
            signal: callbackOptions.signal,
            requestId: callbackOptions.requestId,
            toolUseID: request.toolUseID ?? callbackOptions.requestId,
          },
          // The dialog is a control request, not a tool call, so no
          // tool_result would ever settle a tool row started for it.
          { startToolCall: false },
        );
        if (result.behavior !== "allow") return { behavior: "cancelled" as const };
        const answers =
          result.updatedInput === undefined
            ? undefined
            : Reflect.get(result.updatedInput, "answers");
        const selection =
          typeof answers === "object" && answers !== null
            ? Reflect.get(answers, question)
            : undefined;
        return {
          behavior: "completed" as const,
          result:
            selection === CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER
              ? ("compact" as const)
              : selection === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER
                ? ("never" as const)
                : ("continue" as const),
        };
      }),
    );

  return {
    canUseToolEffect,
    canUseTool,
    onElicitation,
    onElicitationEffect,
    onUserDialog,
  };
};
