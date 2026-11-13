import { pipe } from "effect/Function";
import { codexUsageLimitResetAt } from "../../../provider/codexUsageLimits.ts";
import type { OrchestrationV2ProviderTurn, ProviderUserInputAnswers, ProviderApprovalDecision } from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describeMcpElicitation, toMcpElicitationResponse } from "../../../provider/CodexMcpElicitation.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, approvalDecisionToLegacyReviewDecision, codexFileChangeApprovalPrompt, permissionsResponseFromDecision, providerRequestKindFromPermissions, providerTurnStatusToTerminal, toCodexUserInputAnswers, toProtocolError } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { codexErrorInfoCode, codexExhaustionHttpStatus, codexUsageLimitError, type ActiveCodexProviderRetry, type ActiveCodexTurnContext, type CodexErrorInfo, type CodexRootTerminalEvent, withCodexManagedFailure } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";
import type { EmitRootTerminalPart } from "./EmitRootTerminal.ts";
import type { ProjectGeneratedImagesPart } from "./ProjectGeneratedImages.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart & ProjectGeneratedImagesPart;

export const installMakeRootTerminalEvent = Effect.fnUntraced(function* (deps: Deps) {
  const { awaitActiveTurn, buildApprovalRequestArtifacts, buildUserInputRequestArtifacts, client, emitProviderEvent, findActiveTurnByNativeThreadId, input, pendingRuntimeRequests, rateLimitSnapshot, resolveItemOrdinal, sessionAllowance } = deps;

yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return yield* toProtocolError(
              `No active Codex turn context for approval turn ${payload.turnId}.`,
              payload,
            );
          }
          const allowance = sessionAllowance(payload.threadId, context);
          if (allowance.has("command")) {
            return {
              decision: "acceptForSession",
            } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
          }

          const nativeRequestId = payload.approvalId ?? payload.itemId;
          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: payload.itemId,
            nativeRequestId,
            requestKind: "command",
            ...((payload.reason ?? payload.command) === undefined
              ? {}
              : { prompt: payload.reason ?? payload.command }),
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              type: "approval",
              requestKind: "command",
              decision,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          if (resolved === "acceptForSession" || resolved === "acceptAlways") {
            allowance.add("command");
          }
          return {
            decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
          } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
        }).pipe(Effect.orDie),
      );

yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return yield* toProtocolError(
              `No active Codex turn context for file change approval turn ${payload.turnId}.`,
              payload,
            );
          }
          const allowance = sessionAllowance(payload.threadId, context);
          if (allowance.has("file-change")) {
            return {
              decision: "acceptForSession",
            } satisfies CodexSchema.FileChangeRequestApprovalResponse;
          }

          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: payload.itemId,
            nativeRequestId: payload.itemId,
            requestKind: "file-change",
            prompt:
              codexFileChangeApprovalPrompt({
                ...payload,
                fileChanges: context.fileChangeKindsByItem.get(payload.itemId) ?? {},
              }) ?? null,
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              type: "approval",
              requestKind: "file-change",
              decision,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          if (resolved === "acceptForSession" || resolved === "acceptAlways") {
            allowance.add("file-change");
          }
          return {
            decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
          } satisfies CodexSchema.FileChangeRequestApprovalResponse;
        }).pipe(Effect.orDie),
      );

yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return yield* toProtocolError(
              `No active Codex turn context for permissions approval turn ${payload.turnId}.`,
              payload,
            );
          }

          const requestKind = providerRequestKindFromPermissions(payload.permissions);
          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: payload.itemId,
            nativeRequestId: payload.itemId,
            requestKind,
            ...(payload.reason === undefined ? {} : { prompt: payload.reason }),
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              type: "approval",
              requestKind,
              decision,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          return permissionsResponseFromDecision({
            decision: resolved,
            permissions: payload.permissions,
          });
        }).pipe(Effect.orDie),
      );

yield* client.handleServerRequest("mcpServer/elicitation/request", (payload) =>
        Effect.gen(function* () {
          if (toMcpElicitationResponse(payload, "accept").action !== "accept") {
            yield* Effect.logWarning("Declined an unsupported MCP elicitation.", {
              serverName: payload.serverName,
              mode: payload.mode,
            });
            return {
              action: "decline",
            } satisfies CodexSchema.McpServerElicitationRequestResponse;
          }
          const context =
            payload.turnId === undefined || payload.turnId === null
              ? undefined
              : yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            yield* Effect.logWarning(
              "Declined an MCP elicitation without an active Codex turn context.",
              { serverName: payload.serverName },
            );
            return {
              action: "decline",
            } satisfies CodexSchema.McpServerElicitationRequestResponse;
          }

          const nativeRequestId =
            payload.mode === "url"
              ? payload.elicitationId
              : `mcp-elicitation:${payload.serverName}`;
          const described = describeMcpElicitation(payload);
          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: nativeRequestId,
            nativeRequestId,
            requestKind: "mcp-elicitation",
            prompt: payload.message,
            appName: described.appName,
            options: described.options,
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              type: "approval",
              requestKind: "mcp-elicitation",
              decision,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          return toMcpElicitationResponse(payload, resolved);
        }).pipe(Effect.orDie),
      );

yield* client.handleServerRequest("execCommandApproval", (payload) =>
        Effect.gen(function* () {
          const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
          if (context === undefined) {
            return yield* toProtocolError(
              `No active Codex turn context for exec approval thread ${payload.conversationId}.`,
              payload,
            );
          }
          const allowance = sessionAllowance(payload.conversationId, context);
          if (allowance.has("command")) {
            return {
              decision: "approved_for_session",
            } satisfies CodexSchema.ExecCommandApprovalResponse;
          }

          const nativeRequestId = payload.approvalId ?? payload.callId;
          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: payload.callId,
            nativeRequestId,
            requestKind: "command",
            prompt: payload.reason ?? payload.command.join(" "),
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              type: "approval",
              requestKind: "command",
              decision,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          if (resolved === "acceptForSession" || resolved === "acceptAlways") {
            allowance.add("command");
          }
          return {
            decision: approvalDecisionToLegacyReviewDecision(resolved),
          } satisfies CodexSchema.ExecCommandApprovalResponse;
        }).pipe(Effect.orDie),
      );

yield* client.handleServerRequest("applyPatchApproval", (payload) =>
        Effect.gen(function* () {
          const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
          if (context === undefined) {
            return yield* toProtocolError(
              `No active Codex turn context for apply patch approval thread ${payload.conversationId}.`,
              payload,
            );
          }
          const allowance = sessionAllowance(payload.conversationId, context);
          if (allowance.has("file-change")) {
            return {
              decision: "approved_for_session",
            } satisfies CodexSchema.ApplyPatchApprovalResponse;
          }

          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: payload.callId,
            nativeRequestId: payload.callId,
            requestKind: "file-change",
            prompt: codexFileChangeApprovalPrompt(payload) ?? null,
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              type: "approval",
              requestKind: "file-change",
              decision,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          if (resolved === "acceptForSession" || resolved === "acceptAlways") {
            allowance.add("file-change");
          }
          return {
            decision: approvalDecisionToLegacyReviewDecision(resolved),
          } satisfies CodexSchema.ApplyPatchApprovalResponse;
        }).pipe(Effect.orDie),
      );

yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return yield* toProtocolError(
              `No active Codex turn context for user input request turn ${payload.turnId}.`,
              payload,
            );
          }

          const artifacts = yield* buildUserInputRequestArtifacts({
            context,
            nativeItemId: payload.itemId,
            nativeRequestId: payload.itemId,
            questions: payload.questions,
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
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: CODEX_PROVIDER,
            threadId: artifacts.node.threadId,
            runtimeRequest: artifacts.request,
          });

          const resolved = yield* Deferred.await(answers).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          return {
            answers: toCodexUserInputAnswers(
              resolved,
              new Set(payload.questions.map((question) => question.id)),
            ),
          } satisfies CodexSchema.ToolRequestUserInputResponse;
        }).pipe(Effect.orDie),
      );

const makeRootTerminalEvent = Effect.fn("CodexAdapterV2.makeRootTerminalEvent")(
        function* (input: {
          readonly context: ActiveCodexTurnContext;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly failureMessage?: string;
          readonly failureErrorInfo?: CodexErrorInfo;
          readonly providerRetry?: ActiveCodexProviderRetry;
        }): Effect.fn.Return<CodexRootTerminalEvent> {
          const terminalStatus = providerTurnStatusToTerminal(input.status);
          if (terminalStatus === "failed") {
            const previousFailure = input.context.latestProviderFailure ?? input.providerRetry;
            const failureCode =
              input.failureErrorInfo === undefined
                ? undefined
                : codexErrorInfoCode(input.failureErrorInfo);
            const failureClass = codexUsageLimitError(failureCode ?? null, input.failureErrorInfo)
              ? "usage_limit"
              : "provider_error";
            // The notification carries the richer message, so it wins when the
            // completion repeats it. An explicit exhaustion status on the
            // completion still decides the class; a missing one is not evidence.
            const exhaustionStatus = codexExhaustionHttpStatus(input.failureErrorInfo);
            const failure =
              previousFailure !== undefined &&
              (input.failureMessage === undefined ||
                input.failureMessage === previousFailure.nativeMessage) &&
              (failureCode === undefined || failureCode === previousFailure.nativeCode) &&
              (exhaustionStatus === null || previousFailure.failure.class === failureClass)
                ? previousFailure.failure
                : withCodexManagedFailure(
                    makeProviderFailure({
                      message: input.failureMessage,
                      code: failureCode,
                      class: failureClass,
                    }),
                    input.failureMessage,
                  );
            return {
              type: "turn.terminal",
              driver: CODEX_PROVIDER,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              runOrdinal: input.context.input.runOrdinal,
              failureItemOrdinal: yield* resolveItemOrdinal(
                input.context,
                `terminal-failure:${input.context.providerTurnId}`,
              ),
              status: terminalStatus,
              failure:
                failure.class === "usage_limit"
                  ? {
                      ...failure,
                      resetAt: codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot)),
                    }
                  : failure,
              ...(input.providerRetry === undefined
                ? {}
                : {
                    retry: input.providerRetry.retry,
                    retryStartedAt: input.providerRetry.startedAt,
                  }),
              threadDisposition: "reusable",
            };
          }
          return {
            type: "turn.terminal",
            driver: CODEX_PROVIDER,
            providerThreadId: input.context.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            runOrdinal: input.context.input.runOrdinal,
            status: terminalStatus,
            failure: null,
            ...(terminalStatus === "interrupted" && input.context.hookStopReason !== undefined
              ? { reason: input.context.hookStopReason }
              : {}),
            threadDisposition: "reusable",
          };
        },
      );

  return { makeRootTerminalEvent };
});

export type MakeRootTerminalEventPart = ReturnType<typeof installMakeRootTerminalEvent> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installMakeRootTerminalEvent>;
